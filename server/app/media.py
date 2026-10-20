import io
import time
from pathlib import Path
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.models import Asset
from app.security import media_signature


def signed_url(asset_id: str, exp: int | None = None) -> str:
    exp = exp if exp is not None else int(time.time()) + settings.signed_url_seconds
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
    if media.mime.startswith("image/"):
        width, height, _ = inspect_image(media.data)
    asset = Asset(
        user_id=user_id,
        project_id=project_id,
        kind=kind,
        path=persist_bytes(media.data, media.mime),
        width=width,
        height=height,
        mime=media.mime,
        source="generated",
        parent_id=parent_id,
        prompt=prompt,
        model=media.model,
    )
    session.add(asset)
    session.flush()
    return asset
