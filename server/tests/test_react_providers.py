"""Provider boundaries verified with local storage and an in-process HTTP transport."""

import io
import json
from decimal import Decimal

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models import Asset, Base, UsageLedger, User
from app.providers import SELECTION_TOOL_SCHEMAS, GeneratedMedia, ProviderError, ProviderHub


@pytest.fixture
def provider_database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'providers.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    monkeypatch.setattr(settings, "deepseek_api_key", "transport-placeholder")
    monkeypatch.setattr(settings, "dashscope_api_key", "transport-placeholder")
    monkeypatch.setattr(settings, "model_budget_cny", 12)
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    (tmp_path / "original.png").write_bytes(output.getvalue())
    with factory() as session:
        user = User(username="provider", password_hash="unused", nickname="provider")
        session.add(user)
        session.flush()
        asset = Asset(user_id=user.id, kind="garment", path="original.png", mime="image/png")
        session.add(asset)
        session.commit()
        asset_id = asset.id
    yield factory, asset_id
    engine.dispose()


def intercept(monkeypatch, handler):
    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler))
    )


def tool_response(name, args):
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "function": {
                                    "name": name,
                                    "arguments": json.dumps(args, ensure_ascii=False),
                                }
                            }
                        ]
                    }
                }
            ],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        },
    )


def test_selection_exposes_whole_allowlist_and_uses_model_parameters(
    provider_database, monkeypatch
):
    factory, _ = provider_database
    allowed = ["chat", "edit_image", "write_note", "revise_script"]
    expected = {
        "image_id": "resolved-by-model",
        "instruction": "恢复袖口细节",
        "reply": "袖口我来补好。",
    }

    def handler(request):
        body = json.loads(request.content)
        assert body["tool_choice"] == "required"
        assert [tool["function"]["name"] for tool in body["tools"]] == allowed
        assert all("reply" in tool["function"]["parameters"]["required"] for tool in body["tools"])
        assert json.loads(body["messages"][-1]["content"])["instruction"] == "照刚刚说的来"
        return tool_response("edit_image", expected)

    intercept(monkeypatch, handler)
    with factory() as session:
        name, result = ProviderHub(session).select_tool(
            allowed, {"stage": "images"}, "照刚刚说的来"
        )
        assert name == "edit_image" and result == expected
        assert session.scalar(select(UsageLedger)).estimated_cny == Decimal("0.003150")


def test_model_cannot_return_a_tool_outside_the_stage(provider_database, monkeypatch):
    factory, _ = provider_database
    intercept(
        monkeypatch,
        lambda request: tool_response(
            "generate_video",
            {
                "image_id": "not-allowed",
                "reply": "开始了",
            },
        ),
    )
    with factory() as session:
        with pytest.raises(ProviderError, match="当前阶段"):
            ProviderHub(session).select_tool(
                ["chat", "revise_script"], {"stage": "script"}, "做视频"
            )
        ledger = session.scalar(select(UsageLedger))
        assert ledger.status == "failed" and ledger.estimated_cny > 0


def test_every_selection_schema_requires_a_reply():
    assert all("reply" in schema["required"] for schema in SELECTION_TOOL_SCHEMAS.values())
    assert "direction_id" in SELECTION_TOOL_SCHEMAS["write_script"]["required"]
    with pytest.raises(ProviderError, match="没有返回回复"):
        ProviderHub._validate_text("chat", {"reply": " ", "blocked_tool": ""}, {}, selection=True)


def test_paid_vision_cache_survives_failed_conversation_rollback(provider_database, monkeypatch):
    factory, asset_id = provider_database
    item = {
        "asset_id": asset_id,
        "category": "衬衫",
        "color": "白色",
        "material": "视觉待确认",
        "style_tags": ["简约"],
    }
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps({"items": [item]})}}],
                "usage": {"prompt_tokens": 2000, "completion_tokens": 100},
            },
        )

    intercept(monkeypatch, handler)
    with factory() as session:
        assert ProviderHub(session).analyze_garments([session.get(Asset, asset_id)]) == [item]
        session.rollback()  # A subsequent direction call failed in the business transaction.
    with factory() as session:
        asset = session.get(Asset, asset_id)
        assert asset.analysis == item
        assert ProviderHub(session).analyze_garments([asset]) == [item]
        assert len(session.scalars(select(UsageLedger)).all()) == 1
    assert len(requests) == 1


def test_fidelity_compares_original_and_render_and_accounts_vision(provider_database, monkeypatch):
    factory, asset_id = provider_database

    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "qwen3-vl-plus"
        content = next(
            message["content"] for message in body["messages"] if message["role"] == "user"
        )
        assert len([part for part in content if part["type"] == "image_url"]) == 2
        assert any(asset_id in part.get("text", "") for part in content)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "garments": [
                                        {
                                            "asset_id": asset_id,
                                            "score": 45,
                                            "diffs": ["胸前口袋缺失"],
                                        }
                                    ],
                                    "overall": 45,
                                    "diffs": ["恢复原衬衫胸前口袋"],
                                }
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 2000, "completion_tokens": 100},
            },
        )

    intercept(monkeypatch, handler)
    with factory() as session:
        asset = session.get(Asset, asset_id)
        media = GeneratedMedia((settings.media_dir / asset.path).read_bytes(), "image/png", "test")
        result = ProviderHub(session).fidelity([asset], media)
        assert result == {"score": 45, "diffs": ["恢复原衬衫胸前口袋"], "auto_fixed": False}
        ledger = session.scalar(select(UsageLedger))
        assert ledger.kind == "vision" and ledger.units["purpose"] == "fidelity"
        assert ledger.estimated_cny == Decimal("0.003000")


def test_accounting_finalization_failure_keeps_paid_result_and_reservation(
    provider_database, monkeypatch
):
    factory, _ = provider_database
    monkeypatch.setattr(
        ProviderHub,
        "_finish",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    with factory() as session:
        paid_media = GeneratedMedia(b"paid-result", "image/png", "test")
        result = ProviderHub(session)._call(
            "image", "0.50", lambda: (paid_media, {}, Decimal("0.5"))
        )
        assert result is paid_media
        ledger = session.scalar(select(UsageLedger))
        assert ledger.status == "reserved" and ledger.estimated_cny == Decimal("0.500000")


def test_video_request_includes_watermark_and_identity_constraint(provider_database, monkeypatch):
    factory, asset_id = provider_database
    submitted = []

    def handler(request):
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["parameters"]["watermark"] is True
            assert (
                "人物面部" in body["input"]["prompt"] and "服装细节不变" in body["input"]["prompt"]
            )
            return httpx.Response(200, json={"output": {"task_id": "task-local"}})
        return httpx.Response(
            200,
            json={
                "output": {
                    "task_status": "SUCCEEDED",
                    "video_url": "https://media.invalid/video.mp4",
                }
            },
        )

    intercept(monkeypatch, handler)
    monkeypatch.setattr(
        ProviderHub,
        "_download",
        staticmethod(lambda *args: GeneratedMedia(b"video", "video/mp4", "test")),
    )
    with factory() as session:
        media = ProviderHub(session).video(
            "轻轻转身", session.get(Asset, asset_id), on_submitted=submitted.append
        )
        assert media.data == b"video" and submitted == ["task-local"]


@pytest.mark.parametrize("passed", [True, False])
def test_edit_check_compares_before_after_and_records_actual_verdict(
    provider_database, monkeypatch, passed
):
    factory, asset_id = provider_database
    region = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}
    expected = {
        "passed": passed,
        "reason": "衣摆已进入裤腰。" if passed else "衣摆仍在裤腰外，指令没有做到。",
    }

    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "qwen3-vl-plus"
        assert body["response_format"] == {"type": "json_object"}
        content = body["messages"][0]["content"]
        images = [part for part in content if part["type"] == "image_url"]
        assert len(images) == 2
        prompt = content[0]["text"]
        assert "衬衫塞进裤腰" in prompt and json.dumps(region, ensure_ascii=False) in prompt
        assert "第一张是改图前，第二张是改图后" in prompt
        assert "无法确认都判passed=false" in prompt
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(expected, ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 2500, "completion_tokens": 100},
            },
        )

    intercept(monkeypatch, handler)
    with factory() as session:
        before = session.get(Asset, asset_id)
        after = Asset(path="original.png", mime="image/png")
        assert ProviderHub(session).check_edit(before, after, "衬衫塞进裤腰", region) == expected
        ledger = session.scalar(select(UsageLedger))
        assert ledger.kind == "vision" and ledger.units["purpose"] == "edit_check"
        assert ledger.units["images"] == 2
        assert ledger.estimated_cny == Decimal("0.003500") and ledger.status == "succeeded"


@pytest.mark.parametrize(
    "invalid",
    [
        {"passed": "true", "reason": "看起来做好了"},
        {"passed": 1, "reason": "看起来做好了"},
        {"passed": True, "reason": " "},
        {"passed": False, "reason": []},
        {"passed": True},
        [True, "做好了"],
    ],
)
def test_edit_check_rejects_untrustworthy_model_results(provider_database, monkeypatch, invalid):
    factory, asset_id = provider_database
    intercept(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(invalid)}}]}
        ),
    )
    with factory() as session:
        asset = session.get(Asset, asset_id)
        with pytest.raises(ProviderError, match="指令核对返回了无效结果"):
            ProviderHub(session).check_edit(asset, asset, "袖口放下来")
        ledger = session.scalar(select(UsageLedger))
        assert ledger.status == "failed" and ledger.estimated_cny > 0


def test_mock_edit_check_stays_local_and_is_explicitly_mock(provider_database, monkeypatch):
    factory, asset_id = provider_database
    monkeypatch.setattr(settings, "mock_providers", True)

    def no_client(self):
        raise AssertionError("Mock edit check must never use HTTP")

    monkeypatch.setattr(ProviderHub, "_client", no_client)
    with factory() as session:
        asset = session.get(Asset, asset_id)
        result = ProviderHub(session).check_edit(asset, asset, "袖口放下来")
        assert result["passed"] is True and "Mock" in result["reason"]
        ledger = session.scalar(select(UsageLedger))
        assert ledger.units["purpose"] == "edit_check" and ledger.estimated_cny == 0


@pytest.mark.parametrize(
    "selection",
    [
        {},
        {"region": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}},
        {"mask_strokes": {"brush": 0.05, "strokes": [[{"x": 0.2, "y": 0.4}]]}},
    ],
)
def test_edit_tool_accepts_optional_local_selection(selection):
    result = {"image_id": "current", "instruction": "袖口放下来", "reply": "好。", **selection}
    ProviderHub._validate_text("edit_image", result, {}, selection=True)
    schema = SELECTION_TOOL_SCHEMAS["edit_image"]
    assert set(schema["required"]) == {"image_id", "instruction", "reply"}
    assert {"region", "mask_strokes"}.issubset(schema["properties"])


@pytest.mark.parametrize(
    "selection",
    [
        {"region": {"x": 0.8, "y": 0, "w": 0.3, "h": 0.4}},
        {"region": {"x": 0, "y": 0, "w": 0, "h": 0.4}},
        {"region": {"x": True, "y": 0, "w": 0.3, "h": 0.4}},
        {"region": {"x": float("nan"), "y": 0, "w": 0.3, "h": 0.4}},
        {"mask_strokes": {"brush": 0.05, "strokes": []}},
        {"mask_strokes": {"brush": 0.05, "strokes": [[]]}},
        {"mask_strokes": {"brush": 0.05, "strokes": [[{"x": -0.2, "y": 0.4}]]}},
        {
            "region": {"x": 0, "y": 0, "w": 0.3, "h": 0.4},
            "mask_strokes": {"brush": 0.05, "strokes": [[{"x": 0.2, "y": 0.4}]]},
        },
    ],
)
def test_edit_tool_rejects_invalid_or_ambiguous_local_selection(selection):
    result = {"image_id": "current", "instruction": "袖口放下来", "reply": "好。", **selection}
    with pytest.raises(ProviderError):
        ProviderHub._validate_text("edit_image", result, {}, selection=True)


def test_mock_reference_resolves_exact_older_version_and_does_not_guess_multiple_refs():
    old = {"id": "image-v1", "shot_id": "shot-1", "version": 1, "status": "succeeded"}
    newer = {"id": "image-v2", "shot_id": "shot-1", "version": 2, "status": "succeeded"}
    context = {
        "stage": "images",
        "images": [newer, old],
        "refs": [old["id"]],
        "referenced_images": [old],
    }
    name, result = ProviderHub._mock_select_tool(
        ["chat", "edit_image"], context, "这张袖口卷起来了，放下来"
    )
    assert name == "edit_image" and result["image_id"] == old["id"]
    name, result = ProviderHub._mock_select_tool(
        ["chat", "edit_image"], {**context, "refs": [old["id"], newer["id"]]}, "这张袖口放下来"
    )
    assert name == "chat"


@pytest.mark.parametrize("instruction", ["生成全身穿搭图", "编辑图：衬衫塞进裤腰"])
def test_generation_and_edit_prompts_exclude_source_tags_and_packaging(
    provider_database, monkeypatch, instruction
):
    factory, asset_id = provider_database

    def handler(request):
        body = json.loads(request.content)
        content = body["input"]["messages"][0]["content"]
        prompt = content[-1]["text"]
        assert instruction in prompt
        for item in ("吊牌", "价签", "织标贴纸", "衣架", "包装", "不能出现", "logo"):
            assert item in prompt
        assert "绝不可迁移" in prompt and "禁止将纸牌变成胸前徽章" in prompt
        return httpx.Response(
            200,
            json={
                "output": {
                    "choices": [{"message": {"content": [{"image": "https://media.invalid/a"}]}}]
                }
            },
        )

    intercept(monkeypatch, handler)
    monkeypatch.setattr(
        ProviderHub,
        "_download",
        staticmethod(lambda *args: GeneratedMedia(b"image", "image/png", "test")),
    )
    with factory() as session:
        assert (
            ProviderHub(session).image(instruction, [session.get(Asset, asset_id)]).data == b"image"
        )


def test_fidelity_ignores_source_tag_text_but_reports_tags_in_finished_image(
    provider_database, monkeypatch
):
    factory, asset_id = provider_database

    def handler(request):
        messages = json.loads(request.content)["messages"]
        assert messages[0]["role"] == "system"
        system_prompt = messages[0]["content"]
        assert "不得要求恢复、清晰化或补齐这些文字" in system_prompt
        assert "NATURAL FABRIC、DENIM" in system_prompt
        assert "纸片、贴片或可拆标签" in system_prompt
        content = next(message["content"] for message in messages if message["role"] == "user")
        prompt = content[0]["text"]
        for item in ("吊牌", "价签", "织标贴纸", "衣架", "包装"):
            assert item in prompt
        assert "不因它们在成品中缺失、文字不一致或不可读而扣还原分" in prompt
        assert "若成品仍出现" in prompt and "diffs明确写明" in prompt
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps({"overall": 100, "diffs": []})}}]},
        )

    intercept(monkeypatch, handler)
    with factory() as session:
        asset = session.get(Asset, asset_id)
        assert ProviderHub(session).fidelity([asset], asset) == {
            "score": 100,
            "diffs": [],
            "auto_fixed": False,
        }
