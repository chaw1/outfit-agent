import logging
import threading
import time

import pytest

from app.config import settings
from app.db import SessionLocal
from app.log_errors import log_exception
from app.main import project_lock


@pytest.mark.integration
def test_polling_reads_return_under_one_second_while_conversation_lock_is_held(api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    api.send(project_id, text="夏季新品，想要松弛感")
    api.wait(project_id, lambda s: not s["active_jobs"], timeout=60)
    locked = threading.Event()
    release = threading.Event()

    def conversation():
        with SessionLocal() as session:
            project_lock(session, project_id)
            locked.set()
            assert release.wait(10)
            session.rollback()

    thread = threading.Thread(target=conversation)
    thread.start()
    try:
        assert locked.wait(5)
        for endpoint in ("state", "messages"):
            started = time.monotonic()
            response = api.request("GET", f"/api/projects/{project_id}/{endpoint}")
            assert time.monotonic() - started < 1, f"/{endpoint} waited on the conversation lock"
            assert response
        assert thread.is_alive(), "Read completed before the conversation released its lock"
    finally:
        release.set()
        thread.join(timeout=10)


def test_full_exception_chain_is_logged_without_credentials(caplog, monkeypatch):
    key = "test-sensitive-provider-key"
    monkeypatch.setattr(settings, "deepseek_api_key", key)
    try:
        try:
            raise ValueError(f"failed credential {key}")
        except ValueError as cause:
            raise RuntimeError("outer failure") from cause
    except RuntimeError as exc:
        with caplog.at_level(logging.ERROR):
            log_exception(logging.getLogger("outfit.test"), "Conversation failed", exc)
    assert key not in caplog.text
    assert "Traceback" in caplog.text and "ValueError" in caplog.text
    assert "RuntimeError" in caplog.text and "test_full_exception_chain" in caplog.text
