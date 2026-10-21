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


def image_cost_cny(images: int = 1) -> Decimal:
    return IMAGE_ESTIMATE_CNY * images


def video_cost_cny() -> Decimal:
    return VIDEO_ESTIMATE_CNY
