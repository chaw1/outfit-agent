"""Bounded local editing: the model sees a crop; only selected pixels are composited."""

from __future__ import annotations

import io
import math
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from app.config import settings
from app.errors import AppError
from app.media import asset_path, label_bounds
from app.models import Asset
from app.providers import GeneratedMedia


def _invalid(message: str) -> AppError:
    return AppError("INVALID_EDIT_REGION", message, 422)


def _unit(value, name: str, *, positive: bool = False) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not 0 <= value <= 1
        or (positive and value == 0)
    ):
        raise _invalid(f"{name}必须是 0 到 1 之间的有效数值" + ("且大于 0" if positive else ""))
    return float(value)


@dataclass
class EditSelection:
    mask: Image.Image
    crop_box: tuple[int, int, int, int]
    region: dict[str, float]
    feather_radius: int

    @property
    def crop_size(self) -> tuple[int, int]:
        left, top, right, bottom = self.crop_box
        return right - left, bottom - top

    @property
    def canvas_box(self) -> tuple[int, int, int, int]:
        # Very narrow crops need padding to meet the provider's aspect limit.
        width, height = self.crop_size
        canvas_width, canvas_height = max(width, math.ceil(height / 6)), max(
            height, math.ceil(width / 6)
        )
        left, top = (canvas_width - width) // 2, (canvas_height - height) // 2
        return left, top, left + width, top + height

    @property
    def canvas_size(self) -> tuple[int, int]:
        width, height = self.crop_size
        return max(width, math.ceil(height / 6)), max(height, math.ceil(width / 6))


def prepare_selection(
    size: tuple[int, int],
    region: dict | None = None,
    mask_strokes: dict | None = None,
) -> EditSelection:
    """Validate normalized geometry and rasterize it without writing any files."""
    if (region is None) == (mask_strokes is None):
        raise _invalid("局部改图请只提供框选区域或涂抹轨迹中的一种")
    width, height = size
    if width <= 0 or height <= 0:
        raise _invalid("原图尺寸无效，无法进行局部改图")
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    if region is not None:
        if not isinstance(region, dict):
            raise _invalid("框选区域格式无效")
        x, y = _unit(region.get("x"), "横坐标"), _unit(region.get("y"), "纵坐标")
        w, h = _unit(region.get("w"), "区域宽度", positive=True), _unit(
            region.get("h"), "区域高度", positive=True
        )
        if x + w > 1 + 1e-9 or y + h > 1 + 1e-9:
            raise _invalid("框选区域超出图片边界，请重新圈选")
        left, top = math.floor(x * width), math.floor(y * height)
        right, bottom = min(width, math.ceil((x + w) * width)), min(
            height, math.ceil((y + h) * height)
        )
        draw.rectangle((left, top, right - 1, bottom - 1), fill=255)
    else:
        if not isinstance(mask_strokes, dict):
            raise _invalid("涂抹轨迹格式无效")
        brush = _unit(mask_strokes.get("brush"), "笔刷粗细", positive=True)
        strokes = mask_strokes.get("strokes")
        if not isinstance(strokes, list) or not strokes:
            raise _invalid("涂抹轨迹不能为空，请先圈出要修改的地方")
        diameter = max(1, round(brush * min(size)))
        radius = diameter / 2
        for stroke in strokes:
            if not isinstance(stroke, list) or not stroke:
                raise _invalid("涂抹轨迹不能为空，请先圈出要修改的地方")
            points = []
            for point in stroke:
                if not isinstance(point, dict):
                    raise _invalid("涂抹坐标格式无效")
                points.append(
                    (
                        _unit(point.get("x"), "涂抹横坐标") * (width - 1),
                        _unit(point.get("y"), "涂抹纵坐标") * (height - 1),
                    )
                )
            if len(points) > 1:
                draw.line(points, fill=255, width=diameter)
            for x, y in points:
                draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    bounds = mask.getbbox()
    if bounds is None:
        raise _invalid("圈选区域为空，请重新圈选")
    left, top, right, bottom = bounds
    if min(right - left, bottom - top) < 2 or sum(mask.histogram()[1:]) < 16:
        raise _invalid("圈选区域太小，请至少圈出 16 个像素并适当加粗笔刷")
    feather = min(8, max(1, round(min(right - left, bottom - top) * 0.06)))
    padding = max(16, math.ceil(max(right - left, bottom - top) * 0.2), 3 * feather)
    crop_box = (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )
    return EditSelection(
        mask=mask,
        crop_box=crop_box,
        region={
            "x": left / width,
            "y": top / height,
            "w": (right - left) / width,
            "h": (bottom - top) / height,
        },
        feather_radius=feather,
    )


def crop_reference(source: Asset, selection: EditSelection) -> GeneratedMedia:
    with Image.open(asset_path(source)) as image:
        crop = image.convert("RGB").crop(selection.crop_box)
    # Edge replication supplies harmless context if an unusually narrow source
    # cannot provide a crop within the provider's supported aspect ratios.
    canvas = crop.resize(selection.canvas_size, Image.Resampling.NEAREST)
    canvas.paste(crop, selection.canvas_box[:2])
    scale = max(1, 240 / min(canvas.size))
    if scale > 1:
        canvas = canvas.resize(
            tuple(math.ceil(value * scale) for value in canvas.size), Image.Resampling.LANCZOS
        )
    output = io.BytesIO()
    canvas.save(output, "PNG")
    return GeneratedMedia(output.getvalue(), "image/png", "local-crop", *canvas.size)


def compose_local_edit(
    source: Asset, generated: GeneratedMedia, selection: EditSelection
) -> GeneratedMedia:
    with Image.open(asset_path(source)) as opened:
        source_image = opened.copy()
    if source_image.mode not in {"RGB", "RGBA"}:
        source_image = source_image.convert("RGB")
    with Image.open(io.BytesIO(generated.data)) as opened:
        edited = opened.convert(source_image.mode).resize(
            selection.canvas_size, Image.Resampling.LANCZOS
        )
    edited = edited.crop(selection.canvas_box)
    original_crop = source_image.crop(selection.crop_box)
    mask = selection.mask.crop(selection.crop_box)
    # Multiplication clips the Gaussian to the original selection. Even its
    # finite tail cannot change a single pixel outside the user's painted mask.
    alpha = ImageChops.multiply(
        mask, mask.filter(ImageFilter.GaussianBlur(selection.feather_radius))
    )
    source_image.paste(Image.composite(edited, original_crop, alpha), selection.crop_box[:2])
    if source.source == "generated":
        # Restore the inherited label even when the user paints over it. Reusing
        # source pixels avoids stamping it twice or changing unselected pixels.
        bounds = label_bounds(source_image.size)
        with Image.open(asset_path(source)) as original:
            source_image.paste(original.convert(source_image.mode).crop(bounds), bounds[:2])
    output = io.BytesIO()
    source_image.save(output, "PNG")
    return GeneratedMedia(output.getvalue(), "image/png", generated.model, *source_image.size)


@contextmanager
def temporary_image_asset(media: GeneratedMedia, source: Asset):
    """Make a provider-readable local reference, never a public or database asset."""
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".edit-", dir=settings.media_dir) as directory:
        path = Path(directory) / "reference.png"
        path.write_bytes(media.data)
        yield Asset(
            id=str(uuid4()),
            user_id=source.user_id,
            project_id=source.project_id,
            kind="reference",
            path=str(path.relative_to(settings.media_dir)),
            width=media.width,
            height=media.height,
            mime=media.mime,
            source="generated",
        )
