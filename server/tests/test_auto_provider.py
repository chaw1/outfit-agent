"""One-click defaults stay local and preserve guided generation behavior."""

from copy import deepcopy

import pytest
from sqlalchemy import create_engine, text

from app.models import Base
from app.providers import DIRECTION, SYSTEM_PROMPT, ProviderError, ProviderHub


def test_project_columns_supply_legacy_defaults_for_direct_database_writes():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO projects(id,user_id,title,brand,brief,stage,garment_asset_ids,"
            "created_at,updated_at) VALUES ('project','user','title','brand','brief',"
            "'brief','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
        assert connection.execute(text("SELECT mode,style_tags FROM projects")).one() == (
            "guided", "[]",
        )
    engine.dispose()


def test_direction_schema_and_prompt_require_style_aware_single_recommendation():
    assert DIRECTION["properties"]["recommended"] == {"type": "boolean"}
    assert "recommended" in DIRECTION["required"]
    assert "context.style_tags" in SYSTEM_PROMPT
    assert "恰好推荐一项" in SYSTEM_PROMPT
    assert "context.mode=auto 默认 3 个" in SYSTEM_PROMPT


@pytest.mark.parametrize("context,expected_id", [
    ({}, "direction-1"),
    ({"style_tags": ["咖啡馆午后"]}, "direction-1"),
    ({"brief": "想在公园户外野餐"}, "direction-3"),
    ({"style_tags": ["户外野餐"]}, "direction-3"),
])
def test_mock_recommends_exactly_one_direction_from_style_and_brief(context, expected_id):
    original = deepcopy(context)
    result = ProviderHub._mock_text("propose_directions", context, "")
    ProviderHub._validate_text("propose_directions", result, context)
    assert [item["id"] for item in result["options"] if item["recommended"]] == [expected_id]
    assert all(isinstance(item["recommended"], bool) for item in result["options"])
    assert context == original


def test_style_tags_reach_mock_directions_and_script_without_changing_brief():
    context = {
        "mode": "auto", "style_tags": ["松弛通勤", "街头胶片"],
        "brief": {"original": "保留这件衣服的颜色和版型"}, "garment_asset_ids": ["garment"],
    }
    original = deepcopy(context)
    directions = ProviderHub._mock_text("propose_directions", context, "")
    assert all("松弛通勤" in option["why"] and "街头胶片" in option["why"]
               for option in directions["options"])
    script = ProviderHub._mock_text("write_script", context, "")
    assert all("松弛通勤" in shot["caption"] and "街头胶片" in shot["caption"]
               for shot in script["shots"])
    assert all("写字楼" in shot["scene"] or "窗边" in shot["scene"] for shot in script["shots"])
    assert context == original


@pytest.mark.parametrize("mode,count", [(None, 4), ("guided", 4), ("auto", 3)])
@pytest.mark.parametrize("name", ["write_script", "revise_script"])
def test_mock_auto_defaults_to_three_shots_and_guided_keeps_four(mode, count, name):
    context = {"garment_asset_ids": ["garment"]}
    if mode is not None:
        context["mode"] = mode
    result = ProviderHub._mock_text(name, context, "")
    ProviderHub._validate_text(name, result, context)
    assert len(result["shots"]) == count
    assert [shot["id"] for shot in result["shots"]] == [f"shot-{i + 1}" for i in range(count)]


@pytest.mark.parametrize("instruction,count", [("请拍五张照片", 5), ("请拍6个镜头", 6)])
def test_explicit_shot_request_overrides_auto_default(instruction, count):
    context = {"mode": "auto", "garment_asset_ids": ["garment"], "brief": instruction}
    result = ProviderHub._mock_text("write_script", context, "")
    assert len(result["shots"]) == count


def test_direction_recommendation_rejects_strings_instead_of_booleans():
    result = ProviderHub._mock_text("propose_directions", {}, "")
    result["options"][0]["recommended"] = "true"
    with pytest.raises(ProviderError, match="布尔"):
        ProviderHub._validate_text("propose_directions", result, {})


@pytest.mark.parametrize("selection", [False, True])
def test_missing_recommendation_survives_provider_boundary(selection):
    result = ProviderHub._mock_text("propose_directions", {}, "")
    for item in result["options"]:
        item.pop("recommended")
    ProviderHub._validate_text("propose_directions", result, {}, selection=selection)
    assert all(item["recommended"] is False for item in result["options"])
    result["options"][1]["recommended"] = True
    result["options"][0].pop("recommended")
    ProviderHub._validate_text("propose_directions", result, {}, selection=selection)
    assert result["options"][0]["recommended"] is False
    assert result["options"][1]["recommended"] is True
