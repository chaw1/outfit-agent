"""Note generation only uses confirmed details from the selected image context."""

import json

import httpx
import pytest

from app.config import settings
from app.providers import ProviderHub

REQUEST = "衬衫塞进裤腰"
ORIGINAL_FACT = "浅蓝衬衫衣摆外放"


def note_context(*, confirmed=False, edit_check=None):
    image = {
        "id": "image-v2",
        "instruction": REQUEST,
        "requested_change": REQUEST,
        "confirmed_visual_facts": [REQUEST if confirmed else ORIGINAL_FACT],
    }
    if edit_check is not None:
        image["edit_check"] = edit_check
    return {"selected_image_ids": ["image-v2"], "images": [image]}


@pytest.mark.parametrize("edit_check", [None, {"passed": False, "reason": "衣摆仍然外放"}])
def test_mock_note_does_not_turn_failed_or_unchecked_requests_into_facts(edit_check):
    result = ProviderHub._mock_text("write_note", note_context(edit_check=edit_check), "")
    assert ORIGINAL_FACT in result["body"]
    assert REQUEST not in result["body"]
    assert "袖口轻轻挽起" not in result["body"]
    assert result["image_ids"] == ["image-v2"]


@pytest.mark.parametrize("edit_check", [{"passed": True}, {"passed": False}])
def test_mock_note_can_use_confirmed_or_actively_accepted_changes(edit_check):
    context = note_context(confirmed=True, edit_check=edit_check)
    result = ProviderHub._mock_text("write_note", context, "")
    assert REQUEST in result["body"]
    assert ORIGINAL_FACT not in result["body"]


def test_mock_note_uses_selected_facts_in_selection_order():
    context = note_context()
    context["images"].extend([
        {"id": "unselected", "confirmed_visual_facts": ["未选图中的红色外套"]},
        {"id": "image-v1", "confirmed_visual_facts": ["窗边自然光"]},
    ])
    context["selected_image_ids"] = ["image-v1", "image-v2"]
    result = ProviderHub._mock_text("write_note", context, "")
    assert "未选图中的红色外套" not in result["body"]
    assert result["body"].index("窗边自然光") < result["body"].index(ORIGINAL_FACT)


def test_mock_note_revision_does_not_append_unconfirmed_instruction():
    context = note_context(edit_check={"passed": False})
    context["note"] = ProviderHub._mock_text("write_note", context, "")
    result = ProviderHub._mock_text("write_note", context, f"正文写成：{REQUEST}")
    assert ORIGINAL_FACT in result["body"]
    assert REQUEST not in result["body"]


def test_mock_title_revision_retains_safe_body_and_cleans_unsafe_previous_body():
    context = note_context(edit_check={"passed": False})
    context["note"] = ProviderHub._mock_text("write_note", context, "")
    previous_body = context["note"]["body"]
    result = ProviderHub._mock_text("write_note", context, "标题改成：轻松通勤日常")
    assert result["title"] == "轻松通勤日常"
    assert result["body"] == previous_body

    context["note"]["body"] = f"今天把{REQUEST}，看着很利落。"
    result = ProviderHub._mock_text("write_note", context, "标题改成：轻松通勤日常")
    assert ORIGINAL_FACT in result["body"]
    assert REQUEST not in result["body"]


def test_text_adapter_sends_fact_boundary_in_system_prompt(monkeypatch):
    context = note_context(edit_check={"passed": False, "reason": "衣摆仍然外放"})
    expected = ProviderHub._mock_text("write_note", context, "")
    observed = []

    def handler(request):
        payload = json.loads(request.content)
        observed.append(payload)
        prompt = payload["messages"][0]["content"]
        assert "requested_change（用户要求怎么改）" in prompt
        assert "confirmed_visual_facts（可确认的画面事实）" in prompt
        assert "只有 edit_check.passed === true 或被用户主动采用" in prompt
        assert "没有核对通过的修改不要写进文案" in prompt
        assert "edit_check 缺失也不代表改图请求已完成" in prompt
        assert "已选图片的改图 instruction >" not in prompt
        assert json.loads(payload["messages"][1]["content"])["context"] == context
        return httpx.Response(200, json={
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "write_note", "arguments": json.dumps(expected, ensure_ascii=False),
            }}]}}],
        })

    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "local-transport-placeholder")
    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(ProviderHub, "_model", lambda self, kind: "local-text-test")
    monkeypatch.setattr(ProviderHub, "_call", lambda self, kind, reserve, operation: operation()[0])
    assert ProviderHub(None).text("write_note", context) == expected
    assert len(observed) == 1
