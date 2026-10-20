"""Boundary matching must remove introduced seams without erasing the edit."""

import io

import pytest
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from app.config import settings
from app.local_edit import (
    _inward_feather,
    _match_boundary_colors,
    compose_local_edit,
    prepare_selection,
)
from app.models import Asset
from app.providers import GeneratedMedia
from scripts.verify_seams import metrics


def encode(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def test_boundary_matching_corrects_color_cast_and_preserves_opaque_interior():
    original = Image.new("RGB", (100, 100), (140, 130, 120))
    edited = Image.new("RGB", original.size, (158, 119, 145))
    mask = Image.new("L", original.size, 0)
    ImageDraw.Draw(mask).rectangle((10, 10, 89, 89), fill=255)
    alpha = _inward_feather(mask, 8)
    matched = _match_boundary_colors(original, edited, alpha, 8)
    assert alpha.getpixel((10, 50)) == 0
    assert matched.getpixel((10, 50)) == original.getpixel((10, 50))
    assert alpha.getpixel((50, 50)) == 255
    assert matched.getpixel((50, 50)) == edited.getpixel((50, 50))
    assert ImageChops.multiply(alpha, ImageChops.invert(mask)).getbbox() is None


@pytest.mark.parametrize("mode", ["RGB", "RGBA"])
def test_composite_has_no_boundary_jump_and_keeps_the_actual_edit(tmp_path, monkeypatch, mode):
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    image = Image.new(mode, (240, 240))
    image.putdata([
        (90 + x // 4, 95 + y // 5, 100 + x // 8) + ((255,) if mode == "RGBA" else ())
        for y in range(240) for x in range(240)
    ])
    (tmp_path / "source.png").write_bytes(encode(image))
    source = Asset(path="source.png", mime="image/png", width=240, height=240, source="upload")
    selection = prepare_selection(image.size, region={"x": .25, "y": .25, "w": .5, "h": .5})
    crop = image.crop(selection.crop_box)
    shifted = Image.new(mode, crop.size)
    values = bytearray(crop.tobytes())
    for index in range(0, len(values), len(crop.getbands())):
        values[index] += 18
        values[index + 1] -= 11
        values[index + 2] += 25
    shifted = Image.frombytes(mode, crop.size, bytes(values))
    # The requested structural change stays well inside the transition ring.
    center = (120 - selection.crop_box[0], 120 - selection.crop_box[1])
    ImageDraw.Draw(shifted).rectangle(
        (center[0] - 12, center[1] - 12, center[0] + 12, center[1] + 12), fill="red"
    )
    generated = GeneratedMedia(encode(shifted), "image/png", "test")
    result = compose_local_edit(source, generated, selection)
    with Image.open(io.BytesIO(result.data)) as composed:
        difference = ImageChops.difference(image.convert("RGB"), composed.convert("RGB"))
        for y in range(240):
            for x in range(240):
                if selection.mask.getpixel((x, y)) == 0:
                    assert composed.getpixel((x, y)) == image.getpixel((x, y))
        # Both sides of a newly introduced boundary have zero residual against
        # the original; original gradients are deliberately nonzero here.
        for point in [(60, 100), (179, 100), (100, 60), (100, 179)]:
            assert difference.getpixel(point) == (0, 0, 0)
        assert composed.getpixel((120, 120))[:3] == (255, 0, 0)
        assert composed.getpixel((100, 100)) == shifted.getpixel(
            (100 - selection.crop_box[0], 100 - selection.crop_box[1])
        )


def test_one_pixel_stroke_remains_editable_and_empty_mask_is_transparent():
    mask = Image.new("L", (64, 64), 0)
    ImageDraw.Draw(mask).line((3, 3, 60, 60), fill=255)
    alpha = _inward_feather(mask, 8)
    assert alpha.getbbox() is not None
    assert ImageChops.multiply(alpha, ImageChops.invert(mask)).getbbox() is None
    original, edited = Image.new("RGB", mask.size, "white"), Image.new("RGB", mask.size, "red")
    matched = _match_boundary_colors(original, edited, alpha, 8)
    assert ImageChops.difference(matched, edited).getbbox() is None
    assert ImageChops.difference(Image.composite(matched, original, alpha), original).getbbox()
    assert _inward_feather(Image.new("L", mask.size, 0), 8).getbbox() is None


@pytest.mark.parametrize("connected", [False, True])
def test_mixed_width_strokes_keep_thin_branches_without_reopening_the_thick_seam(connected):
    mask = Image.new("L", (120, 100), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((60, 20, 109, 79), fill=255)
    draw.line((10, 50, 60 if connected else 40, 50), fill=255, width=1)
    alpha = _inward_feather(mask, 8)
    assert alpha.getpixel((25, 50)) > 0
    assert alpha.getpixel((60, 35)) == 0
    assert alpha.getpixel((80, 50)) == 255
    original = Image.new("RGB", mask.size, "white")
    edited = Image.new("RGB", mask.size, "red")
    matched = _match_boundary_colors(original, edited, alpha, 8, mask=mask)
    result = Image.composite(matched, original, alpha)
    assert result.getpixel((25, 50)) != original.getpixel((25, 50))
    assert result.getpixel((60, 35)) == original.getpixel((60, 35))
    red, green, blue = ImageChops.difference(original, result).split()
    changed = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    assert ImageChops.multiply(changed, ImageChops.invert(mask)).getbbox() is None


def test_no_op_edit_is_pixel_identical_even_near_high_contrast_edges():
    original = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(original).rectangle((50, 0, 99, 99), fill="black")
    mask = Image.new("L", original.size, 0)
    ImageDraw.Draw(mask).ellipse((10, 10, 89, 89), fill=255)
    alpha = _inward_feather(mask, 8)
    matched = _match_boundary_colors(original, original.copy(), alpha, 8)
    assert ImageChops.difference(matched, original).getbbox() is None
    composed = Image.composite(matched, original, alpha)
    assert ImageChops.difference(composed, original).getbbox() is None
    # A standard Gaussian starts at partial opacity, which caused the defect.
    assert 0 < mask.filter(ImageFilter.GaussianBlur(8)).getpixel((10, 50)) < 255


def test_seam_metric_subtracts_the_existing_image_edge():
    original = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(original).rectangle((50, 0, 99, 99), fill="black")
    mask = Image.new("L", original.size, 0)
    ImageDraw.Draw(mask).rectangle((50, 10, 89, 89), fill=255)
    unchanged = metrics(original, original, mask)
    assert unchanged["original_inner_outer_ring_mean_rgb_distance"] > 100
    assert unchanged["boundary_excess_gradient_mae_rgb_255"] == 0
    assert unchanged["inner_2to8px_residual_gradient_mae_rgb_255"] == 0
    shifted = original.copy()
    ImageDraw.Draw(shifted).rectangle((50, 10, 89, 89), fill=(12, 12, 12))
    introduced = metrics(original, shifted, mask)
    assert introduced["boundary_excess_gradient_mae_rgb_255"] == 12
    assert introduced["outside_changed_pixels"] == 0
