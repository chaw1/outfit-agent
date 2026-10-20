"""Generation estimates shared by confirmation quotes and the usage ledger.

The supported image request returns one image; video requests are fixed at five
seconds in 720P. Mock mode still shows these quotes but records zero actual cost.
"""

from decimal import Decimal

IMAGE_ESTIMATE_CNY = Decimal("0.50")
VIDEO_ESTIMATE_CNY = Decimal("1.50")
AUTO_FIX_ALLOWANCE = Decimal("1.20")


def image_cost_cny(images: int = 1) -> Decimal:
    return IMAGE_ESTIMATE_CNY * images


def video_cost_cny() -> Decimal:
    return VIDEO_ESTIMATE_CNY
