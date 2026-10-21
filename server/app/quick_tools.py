"""Image edit presets and deterministic local image preparation."""

import io
import math

from PIL import Image, ImageFilter

from app.media import asset_path
from app.models import Asset
from app.providers import GeneratedMedia

PRESET_LABELS = {"background": "换背景", "outpaint": "扩图", "upscale": "高清"}
BACKGROUND_SUFFIX = "，人物、服装、姿势、光线方向保持不变"
OUTPAINT_INSTRUCTION = "补全画面边缘的场景，人物与服装不变"
UPSCALE_INSTRUCTION = "将原图高清重绘为 2 倍尺寸，人物、服装、姿势与场景保持不变"


def preset_action(action: dict) -> dict:
    """Canonical instructions are also used for replay identity and edit checks."""
    result = dict(action)
    preset = result.get("preset")
    if preset == "background":
        scene = (result.get("background") or result["instruction"]).strip()
        scene = scene.removeprefix("只换背景为 ").removesuffix(BACKGROUND_SUFFIX).strip()
        result["instruction"] = f"只换背景为 {scene}{BACKGROUND_SUFFIX}"
    elif preset == "outpaint":
        result["instruction"] = OUTPAINT_INSTRUCTION
        result.setdefault("direction", "all")
    elif preset == "upscale":
        result["instruction"] = UPSCALE_INSTRUCTION
    return result


def _png(image: Image.Image, model: str) -> GeneratedMedia:
    output = io.BytesIO()
    image.save(output, "PNG")
    return GeneratedMedia(output.getvalue(), "image/png", model, *image.size)


def outpaint_source(source: Asset, direction: str) -> GeneratedMedia:
    """Keep original pixels, adding 25% white margin along the selected edges.

    The padded reference may have a different aspect; the model still outputs 3:4.
    Top/bottom place the original opposite the new edge; symmetric modes center it.
    """
    if direction not in {"top", "bottom", "horizontal", "all"}:
        raise ValueError("扩图方向无效")
    with Image.open(asset_path(source)) as opened:
        image = opened.convert("RGB")
    dx, dy = math.ceil(image.width / 4), math.ceil(image.height / 4)
    left = right = dx if direction in {"horizontal", "all"} else 0
    top = dy if direction in {"top", "all"} else 0
    bottom = dy if direction in {"bottom", "all"} else 0
    canvas = Image.new("RGB", (image.width + left + right, image.height + top + bottom), "white")
    canvas.paste(image, (left, top))
    return _png(canvas, "outpaint-source")


def upscale_fallback(source: Asset) -> GeneratedMedia:
    with Image.open(asset_path(source)) as opened:
        image = opened.convert("RGB")
    if image.width * image.height * 4 > 40_000_000:
        raise ValueError("原图过大，无法生成 2 倍高清图")
    image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
    image = image.filter(ImageFilter.UnsharpMask(radius=1.2, percent=45, threshold=3))
    return _png(image, "pillow-lanczos")
