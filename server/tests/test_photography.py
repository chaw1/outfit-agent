from copy import deepcopy

import pytest
import test_graph_workflow
from sqlalchemy import select

from app.graph import run_turn
from app.models import Job
from app.photography import NEGATIVES, STYLE_PHOTOGRAPHY, expand_photo_prompt
from app.prompting import HARD_REQUIREMENTS, PROMPT_FIELDS, build_shot_prompt

flow = test_graph_workflow.flow


@pytest.mark.parametrize("tag", [None, *STYLE_PHOTOGRAPHY])
def test_photo_scripts_include_photography_language_and_explicit_negatives(tag):
    photo = expand_photo_prompt({"scene": "街角", "camera": "全身"}, [tag] if tag else [], [])
    assert set(photo) == {"focal", "light", "composition", "moment", "texture"}
    prompt = build_shot_prompt(shot={}, garment_prompt="原衣服", photo=photo)
    for category in ("焦段：", "光线：", "构图：", "瞬间：", "质感：", "mm",
                     "真实皮肤纹理", "不磨皮"):
        assert category in prompt
    assert NEGATIVES in prompt
    # §14.3 explicitly requires this negative. It must never be positive direction.
    assert "棚拍白底" not in prompt.replace("不要棚拍白底", "")
    if tag:
        assert tag in prompt
        assert STYLE_PHOTOGRAPHY[tag][0] in prompt


def test_all_twelve_shared_tags_have_distinct_photography_language():
    assert len(STYLE_PHOTOGRAPHY) == 12
    assert len({tuple(expand_photo_prompt({}, [tag], []).values())
                for tag in STYLE_PHOTOGRAPHY}) == 12


def test_reference_light_and_composition_override_style_defaults_without_mutating_input():
    shot = {"scene": "霓虹街角", "pose": "走动", "camera": "全身"}
    refs = [{"lighting": "紫色霓虹侧逆光", "composition": "从路沿低角度斜拍，左侧留白"}]
    before = deepcopy((shot, refs))
    photo = expand_photo_prompt(shot, ["咖啡馆午后", "雨天街角"], refs)
    prompt = build_shot_prompt(shot=shot, garment_prompt="原衣服", photo=photo)
    assert "最高优先锚点" in prompt
    assert "光线：紫色霓虹侧逆光" in prompt
    assert "构图：从路沿低角度斜拍，左侧留白" in prompt
    assert "光线：咖啡馆窗光" not in prompt
    assert "辅助风格仅补充质感：雨天街角" in prompt
    assert (shot, refs) == before


def test_previews_and_formal_shots_store_and_deliver_expansion_without_changing_clothes(flow):
    session, project, _, graph = flow
    project.style_tags = ["街头胶片"]
    session.commit()
    first = run_turn(graph, project, "开始", None)
    direction = next(card for card in first["cards"] if card["type"] == "directions")["options"][0]
    run_turn(graph, project, None, {"type": "choose_direction", "direction_id": direction["id"]})
    run_turn(graph, project, None, {"type": "confirm_script"})
    jobs = list(session.scalars(select(Job)))
    assert any(job.payload.get("purpose") == "preview" for job in jobs)
    assert any(job.payload.get("shot_id") for job in jobs)
    for job in jobs:
        assert list(job.payload["prompt_fields"]) == list(PROMPT_FIELDS)
        assert all(value in job.payload["prompt"] for value in job.payload["photo_prompt"].values())
        assert "主风格：街头胶片" in job.payload["photo_prompt"]["texture"]
        assert "严格保持原衣服版型、颜色、面料、纽扣、口袋、logo，不得增删或改变" in job.payload[
            "prompt"
        ]
        assert HARD_REQUIREMENTS in job.payload["prompt"]
