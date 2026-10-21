"""模型输出偶发不合格时：多余字段直接丢弃；缺必填字段自动再问一次，第二次仍不合格才报错。"""

import json

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Asset, Base, Project, User
from app.providers import ProviderError, ProviderHub
from app.workflow import ALLOWED_TOOLS


@pytest.fixture
def direction_database(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "local-transport-placeholder")
    engine = create_engine(f"sqlite:///{tmp_path / 'retry.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        user = User(username="retry", password_hash="unused", nickname="本地测试", profile={})
        session.add(user)
        session.flush()
        garment = Asset(user_id=user.id, kind="garment", path="unused.png", mime="image/png")
        session.add(garment)
        session.flush()
        project = Project(
            user_id=user.id, title="重试", brand="本地品牌", brief="夏季穿搭",
            garment_asset_ids=[garment.id],
        )
        session.add(project)
        session.commit()
        yield session, project
    engine.dispose()

CONTEXT = {"stage": "direction", "recent_messages": [{"role": "user", "text": "要通勤"}]}
TOOLS = sorted(ALLOWED_TOOLS["direction"])


def _good():
    return ProviderHub._mock_text("propose_directions", {}, "")


def _reply(arguments: dict):
    return httpx.Response(200, json={
        "choices": [{"message": {"tool_calls": [{"function": {
            "name": "propose_directions", "arguments": json.dumps(arguments, ensure_ascii=False),
        }}]}}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 200},
    })


def test_extra_fields_are_dropped_instead_of_failing():
    result = _good()
    result["mood"] = "多出来的字段"
    result["options"][0]["extra"] = True
    ProviderHub._validate_text("propose_directions", result, {})
    assert "mood" not in result and "extra" not in result["options"][0]


def test_missing_required_field_is_retried_once_and_usage_is_merged(
    direction_database, monkeypatch
):
    session, project = direction_database
    monkeypatch.setattr(settings, "mock_providers", False)
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            broken = _good()
            del broken["options"][0]["scene"]
            return _reply(broken)
        assert "上一次返回不合格" in body["messages"][-1]["content"]
        return _reply(_good())

    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler))
    )
    name, result = ProviderHub(session, project.id).select_tool(TOOLS, CONTEXT, "换一组方向")
    assert name == "propose_directions" and result == _good()
    assert len(requests) == 2


def test_second_bad_output_still_raises(direction_database, monkeypatch):
    session, project = direction_database
    monkeypatch.setattr(settings, "mock_providers", False)
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        broken = _good()
        del broken["options"][0]["scene"]
        return _reply(broken)

    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler))
    )
    with pytest.raises(ProviderError, match="字段不完整"):
        ProviderHub(session, project.id).select_tool(TOOLS, CONTEXT, "换一组方向")
    assert calls == 2


def test_only_model_output_defects_are_retryable():
    assert ProviderHub._retryable_output(ProviderError("对话模型返回字段不完整。"))
    assert ProviderHub._retryable_output(ProviderError("对话模型未按当前阶段返回工具结果。"))
    assert not ProviderHub._retryable_output(ProviderError("圈选轨迹不能为空。"))
    assert not ProviderHub._retryable_output(ProviderError("框选区域超出图片范围，请重新圈选。"))
