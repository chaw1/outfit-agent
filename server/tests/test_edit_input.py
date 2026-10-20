"""Reject malformed mobile selections before a task or model request is created."""

import asyncio
import json

import pytest
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from app.main import validation_handler
from app.schemas import MessageInput


@pytest.mark.parametrize(
    ("selection", "message"),
    [
        ({"region": {"x": -0.1, "y": 0, "w": 0.2, "h": 0.2}}, "不能越界"),
        ({"region": {"x": 0.9, "y": 0, "w": 0.2, "h": 0.2}}, "超出图片"),
        ({"region": {"x": 0, "y": 0, "w": 0, "h": 0.2}}, "宽高必须大于0"),
        ({"region": {"x": float("nan"), "y": 0, "w": 0.2, "h": 0.2}}, "有效数值"),
        ({"region": {"x": True, "y": 0, "w": 0.2, "h": 0.2}}, "有效数值"),
        ({"region": {"x": 0, "y": 0, "w": 0.2}}, "局部编辑字段无效"),
        ({"mask_strokes": {"brush": 0.1, "strokes": []}}, "轨迹不能为空"),
        ({"mask_strokes": {"brush": 0.1, "strokes": [[]]}}, "轨迹不能为空"),
        (
            {"mask_strokes": {"brush": 0, "strokes": [[{"x": 0.5, "y": 0.5}]]}},
            "笔刷大小必须大于0",
        ),
        (
            {"mask_strokes": {"brush": 0.1, "strokes": [[{"x": 1.1, "y": 0.5}]]}},
            "不能越界",
        ),
        (
            {
                "region": {"x": 0, "y": 0, "w": 0.2, "h": 0.2},
                "mask_strokes": {"brush": 0.1, "strokes": [[{"x": 0.5, "y": 0.5}]]},
            },
            "只能选择一种",
        ),
    ],
)
def test_invalid_selection_has_specific_chinese_api_error(selection, message):
    with pytest.raises(ValidationError) as error:
        MessageInput.model_validate(
            {"action": {"type": "edit_image", "image_id": "image", "instruction": "改袖口",
                        **selection}}
        )
    errors = [{**item, "loc": ("body", *item["loc"])} for item in error.value.errors()]
    response = asyncio.run(validation_handler(None, RequestValidationError(errors)))
    assert response.status_code == 422
    assert message in json.loads(response.body)["error"]["message"]


@pytest.mark.parametrize("refs", [["image", "image"], [""], [" "]])
def test_duplicate_or_blank_refs_are_rejected(refs):
    with pytest.raises(ValidationError, match="引用图片不能为空或重复"):
        MessageInput(text="这张改袖口", refs=refs)


def test_optional_selection_and_refs_are_backwards_compatible():
    body = MessageInput(action={"type": "edit_image", "image_id": "image", "instruction": "改袖口"})
    assert body.refs == []
    assert body.action.region is None and body.action.mask_strokes is None
    strokes = {"brush": 0.1, "strokes": [[{"x": 0.5, "y": 0.5}]]}
    body = MessageInput(
        action={**body.action.model_dump(exclude_none=True), "mask_strokes": strokes}
    )
    assert body.action.mask_strokes.model_dump() == strokes
