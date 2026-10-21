import io
import logging
import shutil
import subprocess
import tempfile
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
logger = logging.getLogger(__name__)


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
        data, mime = (
            label_generated_image(media.data, media.model, draw_label=not preserve_visible_label),
            "image/png",
        )
    elif mime == "video/mp4":
        data = compress_video(data)
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
    warm_previews(asset)
    return asset


def warm_previews(asset: Asset) -> None:
    """Generated images are opened on phones right away: build the preview sizes now."""
    if not asset.mime.startswith("image/"):
        return
    for width in PREVIEW_WIDTHS:
        try:
            preview_path(asset, width)
        except Exception:
            logger.warning("preview warm-up failed for %s at %s", asset.id, width)


VIDEO_FFMPEG_ARGS = (
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "4000k",
    "-bufsize",
    "8000k",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
)


def compress_video(data: bytes) -> bytes:
    """Re-encode generated clips for phone playback on slow links; keep the original on failure."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return data
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder) / "source.mp4"
        target = Path(folder) / "target.mp4"
        source.write_bytes(data)
        try:
            subprocess.run(  # noqa: S603 - fixed ffmpeg binary, temp-file paths only
                [
                    ffmpeg,
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source),
                    *VIDEO_FFMPEG_ARGS,
                    str(target),
                ],
                check=True,
                timeout=120,
                capture_output=True,
            )
        except (subprocess.SubprocessError, OSError):
            logger.warning("video compression failed; storing the original clip")
            return data
        compressed = target.read_bytes()
    return compressed if 0 < len(compressed) < len(data) else data


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


def erase_label(image: Image.Image) -> Image.Image:
    """Cover the disclosure box with the strip right above it (mirrored).

    成片再拿去当改图 / 视频首帧的参考时，右下角的标识会被模型当成画面内容照着画，
    改一版叠一层。参考图先把这个固定区域抹掉，成品落盘时再统一盖一次标识。
    """
    left, top, right, bottom = label_bounds(image.size)
    height = bottom - top
    if height <= 0 or top - height < 0:
        return image
    patch = image.crop((left, top - height, right, top)).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    image.paste(patch, (left, top))
    return image


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


PREVIEW_WIDTHS = (360, 720, 1080)


def preview_path(asset: Asset, width: int) -> Path:
    """Return a cached JPEG preview of an image asset, generating it on first use.

    手机列表与缩略图不需要 3–4 MB 的 PNG 原图；按需缩成固定几档宽度的 JPEG，
    文件放在原图旁边（`<name>.w720.jpg`），随原图一起被清理。
    """
    if width not in PREVIEW_WIDTHS:
        raise AppError("INVALID_PREVIEW", "不支持的预览尺寸", 422)
    original = asset_path(asset)
    target = original.with_name(f"{original.stem}.w{width}.jpg")
    if target.is_file():
        return target
    try:
        with Image.open(original) as image:
            image = image.convert("RGB")
            if image.width > width:
                image.thumbnail((width, int(image.height * width / image.width) + 1))
            # 每次生成用独立的临时文件：同一张图同时来两个请求时，各写各的，再原子替换。
            temporary = target.with_name(f"{target.stem}.{uuid4().hex}.tmp")
            try:
                image.save(temporary, format="JPEG", quality=86, optimize=True)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    except (UnidentifiedImageError, OSError) as exc:
        raise AppError("MEDIA_NOT_FOUND", "文件不存在", 404) from exc
    return target
