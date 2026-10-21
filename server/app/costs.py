"""Generation estimates shared by confirmation quotes and the usage ledger.

The supported image request returns one image; video requests are fixed at five
seconds in 720P. Mock mode still shows these quotes but records zero actual cost.
"""

from decimal import Decimal

IMAGE_ESTIMATE_CNY = Decimal("0.50")
VIDEO_ESTIMATE_CNY = Decimal("1.50")
AUTO_FIX_ALLOWANCE = Decimal("1.20")
POINTS_PER_CNY = 10


def points(cny: Decimal | float | int) -> float:
    return float((Decimal(str(cny)) * POINTS_PER_CNY).quantize(Decimal("0.1")))


def with_points(value):
    """Add display equivalents, including historical cards, without mutating input."""
    if isinstance(value, list):
        return [with_points(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: with_points(item) for key, item in value.items()}
    for key, item in value.items():
        if key.endswith("_cny") and item is not None:
            result[key.removesuffix("_cny") + "_points"] = points(item)
    return result


# 火山方舟 Seedream 5.0 pro：2K 档 0.60 元/张，参考图每张 0.02 元（首张免费）。
SEEDREAM_IMAGE_CNY = Decimal("0.60")
SEEDREAM_REFERENCE_CNY = Decimal("0.02")


def image_cost_cny(images: int = 1) -> Decimal:
    return IMAGE_ESTIMATE_CNY * images


def seedream_image_cost_cny(references: int) -> Decimal:
    return SEEDREAM_IMAGE_CNY + SEEDREAM_REFERENCE_CNY * max(0, references - 1)


def video_cost_cny() -> Decimal:
    return VIDEO_ESTIMATE_CNY


def auto_quote() -> dict:
    breakdown = [
        {"label": "方向预览 3 张", "points": points(image_cost_cny(3))},
        {"label": "正式出图 3 张（含 20% 自动修复预留）",
         "points": points(image_cost_cny(3) * AUTO_FIX_ALLOWANCE)},
        {"label": "5 秒视频 1 条", "points": points(video_cost_cny())},
    ]
    return {"estimate_points": round(sum(item["points"] for item in breakdown), 1),
            "breakdown": breakdown}
