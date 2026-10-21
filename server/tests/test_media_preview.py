"""On-demand JPEG previews for image assets (手机列表与缩略图用)."""

import io
import shutil
import subprocess

import pytest
from PIL import Image

from app.config import settings
from app.errors import AppError
from app.media import PREVIEW_WIDTHS, compress_video, persist_bytes, preview_path, warm_previews
from app.models import Asset


def _png(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (240, 200, 60)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def media_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    return tmp_path


def test_preview_is_resized_jpeg_and_cached(media_dir):
    path = persist_bytes(_png(1536, 2048), "image/png")
    asset = Asset(user_id="u", kind="reference", mime="image/png", path=path)
    first = preview_path(asset, 720)
    assert first.suffix == ".jpg" and first.parent == media_dir
    with Image.open(first) as image:
        assert image.format == "JPEG" and image.width == 720 and 959 <= image.height <= 961
    assert first.stat().st_size < (media_dir / asset.path).stat().st_size
    stamp = first.stat().st_mtime_ns
    assert preview_path(asset, 720) == first and first.stat().st_mtime_ns == stamp


def test_small_images_are_not_upscaled_and_widths_are_fixed(media_dir):
    path = persist_bytes(_png(300, 400), "image/png")
    asset = Asset(user_id="u", kind="garment", mime="image/png", path=path)
    with Image.open(preview_path(asset, PREVIEW_WIDTHS[0])) as image:
        assert (image.width, image.height) == (300, 400)
    with pytest.raises(AppError) as error:
        preview_path(asset, 500)
    assert error.value.status_code == 422


def test_media_route_serves_preview(api):
    """`?w=` 只对图片生效；签名与过期校验不变，非法宽度 422。"""
    uploaded = api.upload("shirt.jpg", "garment")
    original = api.client.get(uploaded["url"])
    assert original.status_code == 200
    assert original.headers["content-type"].startswith("image/")
    preview = api.client.get(f"{uploaded['url']}&w=360")
    assert preview.status_code == 200 and preview.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.width <= 360
    assert len(preview.content) <= len(original.content)
    assert api.client.get(f"{uploaded['url']}&w=999").status_code == 422


def test_warm_previews_builds_every_width_once(media_dir):
    path = persist_bytes(_png(1536, 2048), "image/png")
    asset = Asset(id="warm", user_id="u", kind="image", mime="image/png", path=path)
    warm_previews(asset)
    stems = sorted(p.name for p in media_dir.glob("*.w*.jpg"))
    assert len(stems) == len(PREVIEW_WIDTHS)
    warm_previews(Asset(id="v", user_id="u", kind="video", mime="video/mp4", path="missing.mp4"))


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is only required inside the server image"
)
def test_compress_video_shrinks_generated_clip(tmp_path):
    source = tmp_path / "clip.mp4"
    ffmpeg = shutil.which("ffmpeg")
    subprocess.run(  # noqa: S603 - local ffmpeg synthesises the fixture
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=720x1280:rate=24",
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "10",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        timeout=120,
    )
    original = source.read_bytes()
    compressed = compress_video(original)
    assert 0 < len(compressed) < len(original)
    assert compressed[4:8] == b"ftyp"
    assert compress_video(b"not a video") == b"not a video"
