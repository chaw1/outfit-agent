import io
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageFont

from app.media import label_bounds, label_generated_image


def png(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


@pytest.mark.parametrize("size", [(64, 96), (512, 768), (1024, 1536), (3072, 4096)])
def test_disclosure_stays_in_protected_box_at_all_sizes(size):
    original = Image.new("RGB", size, (86, 112, 145))
    with Image.open(io.BytesIO(label_generated_image(png(original), "test-model"))) as tagged:
        assert tagged.size == size
        assert tagged.info["AIGC"] == "AI生成"
        assert tagged.info["Source"] == "generated"
        assert tagged.info["Model"] == "test-model"
        difference = ImageChops.difference(original, tagged)
        bounds = label_bounds(size)
        assert difference.crop(bounds).getbbox() is not None
        difference.paste((0, 0, 0), bounds)
        assert difference.getbbox() is None


@pytest.mark.parametrize("size", [(512, 768), (1024, 1536), (3072, 4096)])
def test_disclosure_has_antialiased_text_at_small_and_large_sizes(size):
    with Image.open(
        io.BytesIO(label_generated_image(png(Image.new("RGB", size, "black")), "test"))
    ) as tagged:
        patch = tagged.crop(label_bounds(size))
        levels = set(patch.getchannel("R").tobytes())
        assert 255 in levels
        # Solid strokes have white interiors and many intermediate edge values.
        assert len(levels & set(range(40, 240))) > 30


def test_bundled_disclosure_font_has_all_four_distinct_glyphs():
    font = ImageFont.truetype(
        str(Path(__file__).parents[1] / "app/fonts/OutfitDisclosure-Medium.otf"), size=40
    )
    missing = bytes(font.getmask("X"))
    glyphs = [bytes(font.getmask(letter)) for letter in "AI生成"]
    assert len(set(glyphs)) == 4
    assert all(glyph != missing for glyph in glyphs)


@pytest.mark.parametrize("mode", ["RGB", "RGBA"])
def test_metadata_only_save_keeps_existing_disclosure_and_all_pixels(mode):
    original = Image.new(mode, (512, 768), (86, 112, 145))
    once = label_generated_image(png(original), "old-model")
    with Image.open(io.BytesIO(once)) as inherited:
        if mode == "RGBA":
            inherited = inherited.convert("RGBA")
            inherited.putalpha(123)
        twice = label_generated_image(png(inherited), "new-model", draw_label=False)
        with Image.open(io.BytesIO(twice)) as tagged:
            assert tagged.mode == inherited.mode
            assert tagged.tobytes() == inherited.tobytes()
            assert tagged.info["AIGC"] == "AI生成"
            assert tagged.info["Model"] == "new-model"
