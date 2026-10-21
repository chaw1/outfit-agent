"""On-demand JPEG previews for image assets (手机列表与缩略图用)."""

import io

import pytest
from PIL import Image

from app.config import settings
from app.errors import AppError
from app.media import PREVIEW_WIDTHS, persist_bytes, preview_path
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
