import asyncio
import json
import logging
from datetime import timedelta

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.background import BackgroundTask

from app.admin import require_admin
from app.admin import router as admin_router
from app.config import settings
from app.log_errors import log_exception
from app.models import Base, Project, UsageLedger, User, utcnow
from app.observability import (
    RequestObservabilityMiddleware,
    bind_user,
    log_model,
    logger,
    request_events,
    request_totals,
)
from app.providers import ProviderHub
from app.security import get_session


@pytest.fixture
def observed_api():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    app = FastAPI()
    app.state.observability_session_factory = factory
    app.add_middleware(RequestObservabilityMiddleware)
    events = []

    class Capture(logging.Handler):
        def emit(self, record):
            events.append(json.loads(record.getMessage()))

    capture = Capture()
    logger.addHandler(capture)

    def identity(request: Request):
        with factory() as session:
            bind_user(request, "observed-user", session)
        return "observed-user"

    @app.get("/api/projects/{project_id}/sync")
    def sync(project_id: str, user=Depends(identity)):
        log_model(model="mock-sync", duration_ms=3, cost_cny=0)
        return {"ok": True}

    @app.get("/api/projects/{project_id}/stream")
    async def stream(project_id: str, user=Depends(identity)):
        async def body():
            await asyncio.to_thread(log_model, model="mock-thread", duration_ms=5, cost_cny=0)
            yield "event: token\ndata: {}\n\n"
            # The event name can span arbitrary ASGI body chunks.
            yield "eve"
            yield "nt: error\ndata: {}\n\n"
            yield "event: error\ndata: {}\n\n"
        return StreamingResponse(body(), media_type="text/event-stream")

    @app.get("/failure")
    def failure():
        raise RuntimeError("failed upstream https://example.test/run?token=private-query")

    try:
        yield TestClient(app), factory, events, app
    finally:
        logger.removeHandler(capture)
        engine.dispose()


def test_request_id_context_survives_sync_dependency_sse_and_to_thread(observed_api):
    client, factory, events, _ = observed_api
    response = client.get("/api/projects/project-1/sync?token=must-not-log",
                          headers={"X-Request-Id": "client-request-id",
                                   "Authorization": "Bearer must-not-log"})
    assert response.status_code == 200
    assert response.headers["X-Request-Id"] == "client-request-id"
    sync_model = next(row for row in events if row.get("model") == "mock-sync")
    assert sync_model["request_id"] == "client-request-id"
    assert sync_model["user_id"] == "observed-user"
    assert sync_model["project_id"] == "project-1"
    response = client.get("/api/projects/project-2/stream",
                          headers={"X-Request-Id": "stream-request-id"})
    assert response.headers["X-Request-Id"] == "stream-request-id"
    assert "event: error" in response.text
    thread_model = next(row for row in events if row.get("model") == "mock-thread")
    assert thread_model["request_id"] == "stream-request-id"
    assert thread_model["project_id"] == "project-2"
    assert thread_model["user_id"] == "observed-user"
    assert thread_model["cost_cny"] == 0 and thread_model["duration_ms"] == 5
    requests = [row for row in events if row["event"] == "http_request"]
    assert len(requests) == 2 and requests[1]["status_code"] == 200
    assert requests[1]["is_error"] is True and requests[0]["is_error"] is False
    assert all(row["duration_ms"] >= 0 for row in requests)
    assert "must-not-log" not in json.dumps(events)
    with factory() as session:
        assert request_totals(session) == {"requests_24h": 2, "errors_24h": 1}
        assert session.scalar(select(request_events.c.request_id).where(
            request_events.c.project_id == "project-2")) == "stream-request-id"


def test_generated_id_errors_unmatched_and_persisted_rolling_window(observed_api):
    client, factory, events, app = observed_api
    failure = client.get("/failure")
    assert failure.status_code == 500
    assert len(failure.headers["X-Request-Id"]) == 32
    missing = client.get("/missing?password=secret-value", headers={"X-Request-Id": "a" * 200})
    assert missing.status_code == 404
    assert len(missing.headers["X-Request-Id"]) == 32
    assert "private-query" not in json.dumps(events)
    assert "secret-value" not in json.dumps(events)
    with factory() as session:
        session.execute(request_events.insert().values(
            id="old-request", request_id="old", method="GET", route="/old", duration_ms=0,
            status_code=500, is_error=True, created_at=utcnow() - timedelta(hours=25),
        ))
        session.commit()
        assert request_totals(session) == {"requests_24h": 2, "errors_24h": 2}
    # A separate app/process reads the same committed database without in-memory counters.
    second = FastAPI()
    second.add_middleware(RequestObservabilityMiddleware)

    @second.get("/totals")
    def totals():
        with factory() as session:
            return request_totals(session)

    assert TestClient(second).get("/totals").json() == {"requests_24h": 2, "errors_24h": 2}


def test_exception_redaction_covers_password_tokens_bearer_and_url_queries(caplog, monkeypatch):
    monkeypatch.setattr(settings, "deepseek_api_key", "configured-provider-secret")
    exc = RuntimeError(
        "configured-provider-secret Bearer opaque-bearer password=opaque-password "
        'token="opaque-token" https://name:opaque-url-password@example.test/file?sig=opaque-signature'
    )
    with caplog.at_level(logging.ERROR):
        log_exception(logging.getLogger("outfit.test-redaction"), "Failure", exc)
    event = json.loads(caplog.records[-1].getMessage())
    assert event["event"] == "exception" and event["request_id"] is None
    for value in ("configured-provider-secret", "opaque-bearer", "opaque-password",
                  "opaque-token", "opaque-url-password", "opaque-signature"):
        assert value not in event["detail"]
    assert "https://example.test/file" in event["detail"]


def test_admin_overview_reads_durable_24_hour_requests_and_errors(observed_api, monkeypatch):
    client, factory, _, _ = observed_api
    client.get("/api/projects/project-1/sync")
    client.get("/api/projects/project-1/stream")
    client.get("/missing")
    monkeypatch.setattr(settings, "admin_token", "admin-test-only")
    admin_app = FastAPI()
    admin_app.include_router(admin_router)

    def sessions():
        with factory() as session:
            yield session

    admin_app.dependency_overrides[get_session] = sessions
    admin_app.dependency_overrides[require_admin] = lambda: None
    response = TestClient(admin_app).get("/api/admin/overview")
    assert response.status_code == 200
    assert response.json()["requests_24h"] == 3
    assert response.json()["errors_24h"] == 2


def test_provider_accounting_emits_model_duration_cost_and_context(observed_api, monkeypatch):
    client, factory, events, app = observed_api
    monkeypatch.setattr(settings, "mock_providers", True)
    with factory() as session:
        user = User(username="model-log-user", nickname="博主", password_hash="unused")
        session.add(user)
        session.flush()
        project = Project(user_id=user.id, title="日志测试", brand="品牌", brief="需求")
        session.add(project)
        session.commit()
        user_id, project_id = user.id, project.id

    @app.get("/model")
    def model(request: Request):
        with factory() as session:
            bind_user(request, user_id, session)
            ProviderHub(session, project_id).text("chat", {}, "private-conversation")
        return {"ok": True}

    assert client.get("/model", headers={"X-Request-Id": "provider-request"}).status_code == 200
    event = next(row for row in events if row["event"] == "model_call")
    with factory() as session:
        usage = session.scalar(select(UsageLedger))
        assert event["model"] == usage.model
        assert event["duration_ms"] == usage.duration_ms
        assert event["cost_cny"] == float(usage.estimated_cny) == 0
    assert event["request_id"] == "provider-request"
    assert event["user_id"] == user_id and event["project_id"] == project_id
    assert event["status"] == "succeeded"
    assert "private-conversation" not in json.dumps(events)


def test_stream_and_background_failures_cannot_escape_as_unredacted_server_tracebacks(observed_api):
    client, factory, events, app = observed_api

    @app.get("/broken-stream")
    async def broken_stream():
        async def body():
            yield "event: token\ndata: {}\n\n"
            raise RuntimeError("upstream https://example.test/stream?sig=stream-private-query")
        return StreamingResponse(body(), media_type="text/event-stream")

    @app.get("/broken-background")
    def broken_background():
        def fail():
            raise RuntimeError("password=background-private-password")
        return Response("already complete", background=BackgroundTask(fail))

    stream = client.get("/broken-stream", headers={"X-Request-Id": "broken-stream"})
    assert stream.status_code == 200
    assert stream.headers["X-Request-Id"] == "broken-stream"
    assert "event: error" in stream.text and "INTERNAL_ERROR" in stream.text
    background = client.get("/broken-background")
    assert background.status_code == 200 and background.text == "already complete"
    assert "stream-private-query" not in json.dumps(events)
    assert "background-private-password" not in json.dumps(events)
    with factory() as session:
        assert request_totals(session) == {"requests_24h": 2, "errors_24h": 2}
