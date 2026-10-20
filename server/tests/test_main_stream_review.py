"""Regression checks for stream disconnects, upgraded state, and safe error details."""

import asyncio
import json
import logging
import threading
from contextlib import suppress
from decimal import Decimal
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import main
from app.config import settings
from app.log_errors import log_exception
from app.models import Base, Project, UsageLedger, User
from app.providers import ProviderError
from app.schemas import MessageInput, StateOutput


@pytest.fixture
def review_database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'review.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        user = User(username="stream-review", password_hash="unused", nickname="review")
        session.add(user)
        session.flush()
        project = Project(
            user_id=user.id, title="review", brand="review", brief="review", stage="note"
        )
        session.add(project)
        session.commit()
        ids = project.id, user.id
    monkeypatch.setattr(main, "SessionLocal", factory)
    monkeypatch.setattr(main, "project_lock", lambda *args, **kwargs: False)
    monkeypatch.setattr(main, "graph_for", lambda *args: (object(), object()))
    yield factory, ids
    engine.dispose()


def test_legacy_note_state_projects_declaration_and_conservative_total(
    review_database, monkeypatch
):
    factory, (project_id, user_id) = review_database
    old_note = {"title": "旧笔记", "body": "正文", "tags": ["穿搭"], "image_ids": ["image"]}
    monkeypatch.setattr(main, "get_graph_state", lambda *args: {"stage": "note", "note": old_note})
    monkeypatch.setattr(main, "script_versions", lambda *args: [])
    with factory() as session:
        for status, value in (("succeeded", "0.35"), ("reserved", "0.5"), ("failed", "0.5")):
            session.add(
                UsageLedger(
                    project_id=project_id,
                    kind="image",
                    model="test",
                    status=status,
                    estimated_cny=Decimal(value),
                )
            )
        session.commit()
        result = main.get_state(project_id, session.get(User, user_id), session)
        StateOutput.model_validate(result)
        assert result["cost_cny"] == result["note"]["cost_cny"] == 1.35
        assert "AI" in result["note"]["ai_label"] and "发布时" in result["note"]["ai_label"]
        assert "ai_label" not in old_note  # Projection must not mutate durable history.


def test_provider_error_logs_complete_safe_chain_before_sse_error(
    review_database, monkeypatch, caplog
):
    _, (project_id, user_id) = review_database
    secret = "provider-fixture-secret"
    monkeypatch.setattr(settings, "deepseek_api_key", secret)

    def fail(*args, **kwargs):
        try:
            raise RuntimeError(f"upstream header Bearer {secret}")
        except RuntimeError as cause:
            raise ProviderError("模型服务暂时不可用。") from cause

    monkeypatch.setattr(main, "run_turn", fail)
    with caplog.at_level(logging.ERROR):
        events = main.process_turn(project_id, user_id, MessageInput(text="开始"))
    assert len(events) == 1 and "event: error" in events[0]
    assert "PROVIDER_ERROR" in events[0]
    assert secret not in caplog.text and secret not in events[0]
    assert all(value in caplog.text for value in ("Traceback", "RuntimeError", "ProviderError"))


def test_logging_redacts_encoded_database_password_and_escaped_provider_key(monkeypatch, caplog):
    password = "fixture-p@ss/word?"
    secret = 'fixture-key\\"value'
    monkeypatch.setattr(
        settings, "database_url", f"postgresql://user:{quote(password, safe='')}@localhost/db"
    )
    monkeypatch.setattr(settings, "dashscope_api_key", secret)
    encoded = quote(password, safe="")
    escaped = json.dumps(secret)[1:-1]
    try:
        raise RuntimeError(f"driver dsn={encoded}, payload={escaped}")
    except RuntimeError as exc:
        with caplog.at_level(logging.ERROR):
            log_exception(logging.getLogger("review.error"), "failed", exc)
    assert all(value not in caplog.text for value in (password, secret, encoded, escaped))
    assert "Traceback" in caplog.text and "[REDACTED]" in caplog.text


def test_stream_emits_early_and_disconnect_cleans_reader_without_cancelling_work(monkeypatch):
    release = threading.Event()
    completed = threading.Event()

    def work(project_id, user_id, body, emit):
        emit("card", {"id": "garments", "type": "garments", "items": []})
        try:
            assert release.wait(3)
            return [main.sse("done", {"message_id": "completed"})]
        finally:
            completed.set()

    monkeypatch.setattr(main, "process_turn", work)
    monkeypatch.setattr(main, "owned_project", lambda *args: object())

    async def scenario():
        response = main.post_message(
            "project",
            MessageInput(text="开始"),
            SimpleNamespace(id="user"),
            SimpleNamespace(rollback=lambda: None),
        )
        iterator = response.body_iterator
        first = await asyncio.wait_for(anext(iterator), timeout=1)
        assert "event: card" in first and not completed.is_set()
        pending = asyncio.create_task(anext(iterator))
        await asyncio.sleep(0.02)

        def readers():
            return [
                task
                for task in asyncio.all_tasks()
                if getattr(task.get_coro(), "__qualname__", "") == "Queue.get" and not task.done()
            ]

        assert readers(), "The stream must be waiting for its next intermediate event"
        pending.cancel()
        with suppress(asyncio.CancelledError):
            await pending
        assert not readers(), "Disconnect left an orphan queue reader"
        assert not completed.is_set(), "Disconnect cancelled durable background work"
        release.set()
        assert await asyncio.to_thread(completed.wait, 1)
        await asyncio.sleep(0)

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_http_response_sends_garments_card_before_provider_finishes(monkeypatch):
    release = threading.Event()
    finished = threading.Event()

    def work(project_id, user_id, body, emit):
        emit("card", {"id": "early-garments", "type": "garments", "items": []})
        assert release.wait(3)
        finished.set()
        return [main.sse("done", {"message_id": "finished"})]

    monkeypatch.setattr(main, "process_turn", work)
    monkeypatch.setattr(main, "owned_project", lambda *args: object())
    monkeypatch.setitem(
        main.app.dependency_overrides, main.current_user, lambda: SimpleNamespace(id="user")
    )
    monkeypatch.setitem(
        main.app.dependency_overrides,
        main.get_session,
        lambda: SimpleNamespace(rollback=lambda: None),
    )

    async def scenario():
        early = asyncio.Event()
        sent = []
        request_sent = False

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": b'{"text":"start"}', "more_body": False}
            await asyncio.Future()

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and b"early-garments" in message.get(
                "body", b""
            ):
                early.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/projects/project/messages",
            "raw_path": b"/api/projects/project/messages",
            "query_string": b"",
            "root_path": "",
            "server": ("test", 80),
            "client": ("127.0.0.1", 12345),
            "headers": [(b"content-type", b"application/json")],
        }
        request = asyncio.create_task(main.app(scope, receive, send))
        try:
            await asyncio.wait_for(early.wait(), 1)
            assert not request.done() and not finished.is_set()
            start = next(message for message in sent if message["type"] == "http.response.start")
            assert start["status"] == 200
            assert any(
                value.startswith(b"text/event-stream")
                for key, value in start["headers"]
                if key == b"content-type"
            )
            release.set()
            await asyncio.wait_for(request, 2)
            assert any(b"event: done" in message.get("body", b"") for message in sent)
        finally:
            release.set()
            if not request.done():
                request.cancel()
                with suppress(asyncio.CancelledError):
                    await request

    asyncio.run(scenario())
