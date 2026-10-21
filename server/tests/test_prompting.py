"""Seven-field prompts retain shot facts, identity, reference priorities and edit intent."""

from copy import deepcopy

import pytest
import test_graph_workflow
from sqlalchemy import select

from app.graph import run_turn
from app.models import Job, User
from app.photography import expand_photo_prompt
from app.prompting import (
    COVER_ANCHOR,
    HARD_REQUIREMENTS,
    PROMPT_FIELDS,
    attach_identity_anchor,
    build_shot_fields,
    build_shot_prompt,
)

flow = test_graph_workflow.flow


def assert_structure(prompt, fields):
    segments = prompt.split("；", 7)
    assert [part.split("：", 1)[0] for part in segments] == [*PROMPT_FIELDS, "要求"]
    assert list(fields) == list(PROMPT_FIELDS)
    for name, segment in zip(PROMPT_FIELDS, segments, strict=False):
        assert segment == f"{name}：{fields[name]}"
        assert segment.count("。") == 1
    assert HARD_REQUIREMENTS in segments[-1]


@pytest.mark.parametrize("model", [True, False])
@pytest.mark.parametrize("styling", ["白色阔腿裤、棕色乐福鞋", ""])
@pytest.mark.parametrize("anchored", [True, False])
def test_shot_prompt_covers_identity_styling_and_reference_combinations(model, styling, anchored):
    shot = {"scene": "咖啡馆门口", "pose": "侧身回头", "camera": "全身远景", "styling": styling}
    refs = [{"scene": "雨后街角", "lighting": "路灯侧光", "composition": "人物靠右留白"}]
    refs = refs if anchored else []
    before = deepcopy((shot, refs))
    kwargs = {
        "shot": shot, "garment_prompt": "原衣服1：米色棉衬衫。保持纽扣与口袋。",
        "has_model_photo": model,
        "profile": {"height_cm": 168, "body_notes": "肩宽", "style_notes": "不穿高跟鞋"},
        "style_tags": ["松弛通勤"], "references": refs,
    }
    fields = build_shot_fields(**kwargs)
    prompt = build_shot_prompt(**kwargs)
    assert_structure(prompt, fields)
    assert ("保持参考图中模特身份" in fields["人物"]) is model
    assert ("使用成年虚构模特" in fields["人物"]) is not model
    assert all(value in fields["人物"] for value in ("168cm", "肩宽", "不穿高跟鞋"))
    assert "米色棉衬衫" in fields["服装"]
    assert ("整套搭配（已确认）" in fields["服装"]) is bool(styling)
    if styling:
        assert styling in fields["服装"]
    assert "咖啡馆门口" in fields["场景"]
    assert "35mm" in fields["镜头"] and "全身远景" in fields["镜头"]
    assert "3:4 竖版" in fields["构图"] and "三分之二" in fields["构图"]
    assert "侧身回头" in fields["姿势"] and "瞬间" in fields["姿势"]
    if anchored:
        assert "参考图1场景：雨后街角" in fields["场景"]
        assert "参考图1光线：路灯侧光" in fields["光线"]
        assert "参考图1构图：人物靠右留白" in fields["构图"]
        assert "树荫下自然散射光" not in fields["光线"]
    else:
        assert "参考图1" not in prompt
        assert "树荫下自然散射光" in fields["光线"]
    assert "真实皮肤纹理" in prompt and "不要文字水印" in prompt
    assert (shot, refs) == before


def test_cover_anchor_updates_only_identity_and_keeps_saved_payload_immutable():
    fields = build_shot_fields(shot={}, garment_prompt="原衣服1：白衬衫")
    payload = {"prompt_fields": fields, "prompt": build_shot_prompt(fields)}
    before = deepcopy(payload)
    updated = attach_identity_anchor(payload)
    assert_structure(updated["prompt"], updated["prompt_fields"])
    assert COVER_ANCHOR in updated["prompt_fields"]["人物"]
    assert updated["prompt"].count(COVER_ANCHOR) == 1
    assert all(updated["prompt_fields"][name] == fields[name] for name in PROMPT_FIELDS[1:])
    assert attach_identity_anchor(updated) == updated
    assert payload == before


def test_custom_identity_and_punctuation_stay_inside_their_fields():
    fields = build_shot_fields(
        shot={"scene": "街角；门口。", "pose": "回头。回头。"},
        garment_prompt="原衣服1：衬衫；原衣服2：长裤。",
        identity="保留模特身份和未提到的画面细节", identity_anchor="保持妆发；保持光线。",
    )
    prompt = build_shot_prompt(fields, requirements="只做以下修改：衣角放下来")
    assert_structure(prompt, fields)
    assert fields["姿势"].count("回头") == 1
    assert "保留模特身份和未提到的画面细节" in fields["人物"]
    assert "使用成年虚构模特" not in prompt
    assert "只做以下修改：衣角放下来" in prompt


def test_legacy_cover_job_keeps_original_prompt():
    updated = attach_identity_anchor({"prompt": "旧镜头指令，不改变服装"})
    assert updated["prompt"].startswith("人物：" + COVER_ANCHOR)
    assert updated["prompt"].endswith("旧镜头指令，不改变服装")


def test_queue_payload_and_edit_deliver_current_profile_and_confirmed_shot(flow):
    session, project, _, graph = flow
    session.get(User, project.user_id).profile = {
        "height_cm": 170, "body_notes": "肩宽", "style_notes": "偏爱自然妆容",
    }
    session.commit()
    test_graph_workflow.choose_script(graph, project)
    run_turn(graph, project, None, {"type": "confirm_script"})
    jobs = test_graph_workflow.succeed_images(session, project)
    parent = jobs[1]
    parent.payload = {**parent.payload, "anchor_asset_id": jobs[0].result_asset_id}
    session.commit()
    run_turn(graph, project, None, {
        "type": "edit_image", "image_id": parent.id, "instruction": "把衣角放下来",
    })
    edit = session.scalar(select(Job).where(Job.kind == "edit"))
    for job in (parent, edit):
        fields = job.payload["prompt_fields"]
        assert_structure(job.payload["prompt"], fields)
        assert "身高170cm" in fields["人物"] and "偏爱自然妆容" in fields["人物"]
        assert job.payload["shot"]["styling"] in fields["服装"]
        assert isinstance(job.payload["photo_prompt"], dict)
    assert COVER_ANCHOR in edit.payload["prompt_fields"]["人物"]
    assert "保留模特身份和未提到的画面细节" in edit.payload["prompt_fields"]["人物"]
    assert "只做以下修改：把衣角放下来" in edit.payload["prompt"]
    assert edit.payload["photo_prompt"] == expand_photo_prompt(parent.payload["shot"], [], [])
