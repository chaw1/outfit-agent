"""Short, deterministic library tags derived only from existing image analysis."""

import re


def garment_tags(analysis: dict | None) -> list[str]:
    if not isinstance(analysis, dict):
        return []
    result = []
    groups = (
        (("category", "品类"), 1), (("color", "颜色"), 1),
        (("season", "seasons", "季节"), 2), (("style_tags", "style", "风格"), 3),
    )
    for fields, limit in groups:
        added = 0
        for field in fields:
            raw = analysis.get(field)
            values = raw if isinstance(raw, list) else [raw]
            for value in values:
                if not isinstance(value, str):
                    continue
                for word in re.split(r"[、,，;；/|]+", value):
                    tag = word.strip()
                    if 0 < len(tag) <= 12 and tag not in result and added < limit:
                        result.append(tag)
                        added += 1
                        if len(result) == 6:
                            return result
    return result
