import io
import time
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from PIL.PngImagePlugin import PngInfo
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.models import Asset
from app.security import media_signature


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


def inspect_image(data: bytes) -> tuple[int, int, str]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise AppError("INVALID_IMAGE", "仅支持 JPEG、PNG、WebP 图片", 422)
            if image.width * image.height > 40_000_000:
                raise AppError("INVALID_IMAGE", "图片分辨率过大", 422)
            return image.width, image.height, Image.MIME[image.format]
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise AppError("INVALID_IMAGE", "无法读取图片内容", 422) from exc


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
    width, height, mime = inspect_image(data)
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
) -> Asset:
    width, height = media.width, media.height
    data, mime = media.data, media.mime
    if media.mime.startswith("image/"):
        width, height, _ = inspect_image(media.data)
        data, mime = label_generated_image(media.data, media.model), "image/png"
    asset = Asset(
        user_id=user_id,
        project_id=project_id,
        kind=kind,
        path=persist_bytes(data, mime),
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


def label_generated_image(data: bytes, model: str) -> bytes:
    """Embed a visible disclosure and portable PNG provenance metadata.

    The two Chinese glyphs use simple strokes so production images do not
    depend on a system font being installed in the slim worker container.
    """
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB")
    scale = max(1, round(min(image.size) / 1024))
    # Draw at a fixed large size then resize with the canvas for tiny test assets.
    label = Image.new("RGBA", (116, 34), (20, 20, 20, 210))
    draw = ImageDraw.Draw(label)
    font = ImageFont.load_default(size=21)
    draw.text((9, 4), "AI", font=font, fill="white")
    glyphs = [
        [
            [(7, 1), (4, 6)],
            [(5, 5), (14, 5)],
            [(8, 1), (8, 15)],
            [(2, 10), (13, 10)],
            [(1, 15), (15, 15)],
        ],
        [
            [(2, 5), (15, 5)],
            [(3, 5), (3, 10), (1, 15)],
            [(3, 8), (7, 8), (7, 13), (6, 14), (4, 13)],
            [(9, 1), (9, 6), (10, 11), (12, 15), (14, 13)],
            [(12, 1), (14, 3)],
            [(14, 7), (12, 11), (8, 15)],
        ],
    ]
    for offset, strokes in zip((44, 76), glyphs, strict=True):
        for stroke in strokes:
            draw.line([(offset + x * 1.5, 5 + y * 1.5) for x, y in stroke], fill="white", width=2)
    target_width = min(image.width, 116 * scale)
    target_height = max(1, round(target_width * 34 / 116))
    label = label.resize((target_width, target_height), Image.Resampling.LANCZOS)
    margin = min(10 * scale, max(0, (image.width - target_width) // 2))
    image.paste(
        label,
        (image.width - target_width - margin, max(0, image.height - target_height - margin)),
        label,
    )
    metadata = PngInfo()
    metadata.add_itxt("AIGC", "AI生成")
    metadata.add_itxt("Source", "generated")
    metadata.add_itxt("Model", model)
    output = io.BytesIO()
    image.save(output, "PNG", pnginfo=metadata)
    return output.getvalue()
