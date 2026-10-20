import json
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import func, select
from test_worker_providers import local_db as local_db

from app.config import settings
from app.models import Job, UsageLedger
from app.providers import ProviderError, ProviderHub


def test_real_rewrite_uses_plain_text_endpoint_and_only_text_accounting(local_db, monkeypatch):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "unit-test-placeholder")
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        body = requests[-1]
        assert "tools" not in body and "tool_choice" not in body
        assert "functions" not in body and "function_call" not in body
        content = json.loads(body["messages"][1]["content"])
        assert content["previous_reply"] == "这个通勤方向很适合你。"
        return httpx.Response(200, json={
            "choices": [{"message": {"content": " 换个轻松的说法，通勤也能穿得自在。 "}}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        })

    def forbidden(*args, **kwargs):
        pytest.fail("reply rewriting must not invoke any generation tool")

    monkeypatch.setattr(ProviderHub, "_client", lambda _: httpx.Client(
        transport=httpx.MockTransport(handler),
    ))
    monkeypatch.setattr(ProviderHub, "image", forbidden)
    monkeypatch.setattr(ProviderHub, "video", forbidden)
    monkeypatch.setattr(ProviderHub, "select_tool", forbidden)
    with factory() as session:
        hub = ProviderHub(session, project_id, trace_context={"regenerate_message_id": "same-id"})
        result = hub.regenerate_reply("这个通勤方向很适合你。", {"stage": "direction"})
        assert result == "换个轻松的说法，通勤也能穿得自在。"
        assert len(requests) == 1
        rows = session.scalars(select(UsageLedger)).all()
        assert len(rows) == 1
        assert rows[0].kind == "text" and rows[0].status == "succeeded"
        assert rows[0].estimated_cny == Decimal("0.003150")
        assert rows[0].units["regenerate_message_id"] == "same-id"
        assert hub.ledger_ids == [rows[0].id]
        assert session.scalar(select(func.count(Job.id))) == 0


@pytest.mark.parametrize("message", [{"content": " "}, {"tool_calls": [{"id": "ignored"}]}])
def test_invalid_rewrite_keeps_failed_text_reservation_without_jobs(
    local_db, monkeypatch, message,
):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "unit-test-placeholder")
    monkeypatch.setattr(ProviderHub, "_client", lambda _: httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(
            200, json={"choices": [{"message": message}]},
        )),
    ))
    with factory() as session:
        with pytest.raises(ProviderError, match="回复重写未完成"):
            ProviderHub(session, project_id).regenerate_reply("原回复", {})
        row = session.scalar(select(UsageLedger))
        assert row.kind == "text" and row.status == "failed"
        assert row.estimated_cny == Decimal("0.150000")
        assert session.scalar(select(func.count(Job.id))) == 0
