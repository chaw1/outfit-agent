import io
import time
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from PIL.PngImagePlugin import PngInfo
from pillow_heif import register_heif_opener
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.models import Asset
from app.project_cleanup import track_generated_file
from app.security import media_signature

register_heif_opener(thumbnails=False)

def signed_url(asset_id: str, exp: int | None = None) -> str:
    # Round the expiry upward: a URL is stable throughout a six-hour window and
    # remains valid for at least the documented 24 hours even near its end.
    window = 6 * 60 * 60
    exp = (
        exp
        if exp is not None
        else ((int(time.time()) // window) + 1) * window + settings.signed_url_seconds
    )
    return (
        f"{settings.public_base_url.rstrip('/')}/media/{asset_id}"
        f"?exp={exp}&sig={media_signature(asset_id, exp)}"
    )


def asset_dict(asset: Asset) -> dict:
    return {
        "id": asset.id,
        "kind": asset.kind,
        "url": signed_url(asset.id),
        "width": asset.width,
        "height": asset.height,
        "mime": asset.mime,
        "created_at": asset.created_at.isoformat(),
        "source": asset.source,
        "parent_id": asset.parent_id,
        "prompt": asset.prompt,
    }


def asset_path(asset: Asset) -> Path:
    root = settings.media_dir.resolve()
    path = (root / asset.path).resolve()
    if not path.is_relative_to(root):
        raise AppError("MEDIA_NOT_FOUND", "文件不存在", 404)
    return path


def inspect_image(data: bytes, *, upload: bool = False) -> tuple[int, int, str]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            allowed = {"JPEG", "PNG", "WEBP", "HEIF"} if upload else {"JPEG", "PNG", "WEBP"}
            if image.format not in allowed:
                raise AppError(
                    "INVALID_IMAGE", "仅支持 JPEG、PNG、WebP、HEIC 图片", 415 if upload else 422
                )
            if upload and max(image.size) > settings.max_upload_edge:
                raise AppError("IMAGE_TOO_LARGE", "图片最长边不能超过 6000 像素", 413)
            if image.width * image.height > 40_000_000:
                raise AppError("INVALID_IMAGE", "图片分辨率过大", 413 if upload else 422)
            width, height, mime = image.width, image.height, Image.MIME[image.format]
            image.verify()
        if upload:
            with Image.open(io.BytesIO(data)) as image:
                image.load()
        return width, height, mime
    except Image.DecompressionBombError as exc:
        raise AppError("IMAGE_TOO_LARGE", "图片分辨率过大", 413 if upload else 422) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise AppError(
            "INVALID_IMAGE", "无法读取图片内容，请上传有效图片", 415 if upload else 422
        ) from exc


def persist_bytes(data: bytes, mime: str) -> str:
    suffix = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
    }.get(mime)
    if suffix is None:
        raise AppError("INVALID_MEDIA", "不支持的媒体类型", 422)
    relative = f"{uuid4().hex}{suffix}"
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    target = settings.media_dir / relative
    temporary = target.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(target)
    return relative


def store_upload(session: Session, *, user_id: str, kind: str, data: bytes) -> Asset:
    if len(data) > settings.max_upload_bytes:
        raise AppError("FILE_TOO_LARGE", "图片不能超过 15MB", 413)
    width, height, mime = inspect_image(data, upload=True)
    if mime in {"image/heif", "image/heic"}:
        with Image.open(io.BytesIO(data)) as image:
            output = io.BytesIO()
            image.convert("RGB").save(output, "JPEG", quality=95)
        data, mime = output.getvalue(), "image/jpeg"
    asset = Asset(
        user_id=user_id,
        kind=kind,
        path=persist_bytes(data, mime),
        width=width,
        height=height,
        mime=mime,
        source="upload",
    )
    session.add(asset)
    session.flush()
    return asset


def store_generated(
    session: Session,
    *,
    user_id: str,
    project_id: str,
    kind: str,
    media,
    parent_id: str | None = None,
    prompt: str | None = None,
    preserve_visible_label: bool = False,
) -> Asset:
    width, height = media.width, media.height
    data, mime = media.data, media.mime
    if media.mime.startswith("image/"):
        width, height, _ = inspect_image(media.data)
        data, mime = label_generated_image(
            media.data, media.model, draw_label=not preserve_visible_label
        ), "image/png"
    relative = persist_bytes(data, mime)
    track_generated_file(session, relative)
    asset = Asset(
        user_id=user_id,
        project_id=project_id,
        kind=kind,
        path=relative,
        width=width,
        height=height,
        mime=mime,
        source="generated",
        parent_id=parent_id,
        prompt=prompt,
        model=media.model,
    )
    session.add(asset)
    session.flush()
    return asset


def label_generated_image(data: bytes, model: str, *, draw_label: bool = True) -> bytes:
    """Embed an antialiased disclosure using the bundled OFL font subset."""
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB") if draw_label else source.copy()
    if not draw_label:
        return _generated_png(image, model)
    left, top, right, bottom = label_bounds(image.size)
    target_width, target_height = right - left, bottom - top
    # Render at the actual target size with supersampling: a fixed bitmap would
    # become visibly jagged when a large image uses a larger disclosure box.
    supersample = 4
    label = Image.new(
        "RGBA", (target_width * supersample, target_height * supersample), (20, 20, 20, 210)
    )
    draw = ImageDraw.Draw(label)
    font = ImageFont.truetype(
        str(Path(__file__).with_name("fonts") / "OutfitDisclosure-Medium.otf"),
        size=max(1, round(target_height * 0.76 * supersample)),
    )
    text = "AI生成"
    text_left, text_top, text_right, text_bottom = draw.textbbox((0, 0), text, font=font)
    position = (
        (label.width - (text_right - text_left)) / 2 - text_left,
        (label.height - (text_bottom - text_top)) / 2 - text_top,
    )
    draw.text(position, text, font=font, fill="white")
    label = label.resize((target_width, target_height), Image.Resampling.LANCZOS)
    image.paste(label, (left, top), label)
    return _generated_png(image, model)


def label_bounds(size: tuple[int, int]) -> tuple[int, int, int, int]:
    """The inherited disclosure occupies this exact pixel box on every version."""
    width, height = size
    scale = max(1, round(min(size) / 1024))
    label_width = min(width, 116 * scale)
    label_height = max(1, round(label_width * 34 / 116))
    margin = min(10 * scale, max(0, (width - label_width) // 2))
    left, top = width - label_width - margin, max(0, height - label_height - margin)
    return left, top, left + label_width, min(height, top + label_height)


def _generated_png(image: Image.Image, model: str) -> bytes:
    metadata = PngInfo()
    metadata.add_itxt("AIGC", "AI生成")
    metadata.add_itxt("Source", "generated")
    metadata.add_itxt("Model", model)
    output = io.BytesIO()
    image.save(output, "PNG", pnginfo=metadata)
    return output.getvalue()
