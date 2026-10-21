import csv
import io
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import rate_limits
from app.config import settings
from app.main import app
from app.models import Asset, Base, Job, Message, Project, UsageLedger, User
from app.security import get_session, hash_password, issue_token
from app.worker import claim_job


@pytest.fixture
def admin_api(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    rate_limits.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)
    monkeypatch.setattr(settings, "admin_token", "temporary-admin-test-token")
    monkeypatch.setattr(settings, "mock_providers", True)

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    client = TestClient(app)
    response = client.post("/api/admin/login", json={"token": settings.admin_token})
    assert response.status_code == 200
    client.headers["Authorization"] = "Bearer " + response.json()["token"]
    with factory() as session:
        user = User(username="admin_test_user", nickname="测试用户", password_hash=hash_password(
            "test-password-123"
        ))
        session.add(user)
        session.flush()
        session.add(Asset(
            id="test-garment", user_id=user.id, kind="garment", path="unused.jpg", mime="image/jpeg"
        ))
        project = Project(user_id=user.id, title="测试项目", brand="品牌", brief="需求")
        session.add(project)
        session.commit()
        user_id, project_id = user.id, project.id
    try:
        yield client, factory, user_id, project_id
    finally:
        client.close()
        app.dependency_overrides.pop(get_session, None)
        engine.dispose()


def test_admin_requires_separate_expiring_session(admin_api, monkeypatch):
    client, _, user_id, _ = admin_api
    for headers in ({"Authorization": ""}, {"Authorization": "Bearer " + issue_token(user_id)}):
        assert client.get("/api/admin/overview", headers=headers).status_code == 401
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/admin/login", json={"token": "错误口令"}).status_code == 401
    claims = jwt.decode(
        client.headers["Authorization"].split()[1], options={"verify_signature": False}
    )
    assert claims["aud"] == "outfit-admin" and claims["kind"] == "admin"
    assert claims["exp"] - claims["iat"] == 8 * 3600
    assert settings.admin_token not in str(claims)
    old = settings.admin_token
    monkeypatch.setattr(settings, "admin_token", old + "-rotated")
    assert client.get("/api/admin/overview").status_code == 401


def test_admin_serves_shared_design_tokens(admin_api):
    client, _, _, _ = admin_api
    page = client.get("/admin")
    assert 'href="/admin/tokens.css"' in page.text
    response = client.get("/admin/tokens.css")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/css")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "--color-paper-action:" in response.text
    assert "--layout-touch: 44px;" in response.text


def test_empty_admin_token_closes_every_admin_surface(admin_api, monkeypatch):
    client, _, _, _ = admin_api
    monkeypatch.setattr(settings, "admin_token", "")
    for path in (
        "/admin", "/admin/tokens.css", "/admin/assets/app.js",
        "/api/admin/overview", "/api/admin/settings",
    ):
        assert client.get(path).status_code == 404
    assert client.post("/api/admin/login", json={"token": "anything"}).status_code == 404
    assert client.post("/api/admin/login", content="broken-json").status_code == 404


def test_deleted_user_status_is_visible_and_enabling_cannot_restore_login(
    admin_api, tmp_path, monkeypatch,
):
    client, factory, user_id, _ = admin_api
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    token = issue_token(user_id)
    user_headers = {"Authorization": "Bearer " + token}
    deleted = client.request("DELETE", "/api/me", headers=user_headers, json={
        "password": "test-password-123",
    })
    assert deleted.status_code == 204
    row = next(user for user in client.get("/api/admin/users").json() if user["id"] == user_id)
    assert row["deleted_at"] and row["username"] == "deleted-" + user_id[:8]
    assert row["project_count"] == 0
    assert "已注销" in client.get("/admin").text
    assert client.patch("/api/admin/users/" + user_id, json={"disabled": False}).status_code == 200
    assert client.get("/api/me", headers=user_headers).status_code == 401
    assert client.post("/api/auth/login", json={
        "username": row["username"], "password": "test-password-123",
    }).status_code == 401
    with factory() as session:
        assert session.get(User, user_id).deleted_at is not None


def test_overview_usage_filter_dates_and_safe_csv(admin_api):
    client, factory, user_id, project_id = admin_api
    with factory() as session:
        other = User(username="=unsafe_formula", nickname="别的用户", password_hash="unused")
        session.add(other)
        session.flush()
        for owner, when, cost in (
            (user_id, datetime.now(UTC), "1.25"),
            (other.id, datetime.now(UTC), "2.75"),
            (user_id, datetime.now(UTC) - timedelta(days=40), "3"),
        ):
            session.add(UsageLedger(
                user_id=owner, project_id=project_id, model="mock-image", kind="image",
                duration_ms=120, estimated_cny=Decimal(cost), created_at=when,
            ))
        session.commit()
    overview = client.get("/api/admin/overview").json()
    assert overview["users"] == 2 and overview["projects"] == 1
    assert overview["today"] == {"calls": 2, "cost_cny": 4}
    assert overview["total"] == {"calls": 3, "cost_cny": 7}
    assert overview["stages"] == [{"stage": "brief", "count": 1}]
    for group in ("model", "user", "day"):
        report = client.get("/api/admin/usage", params={"group": group, "user_id": user_id})
        assert report.status_code == 200
        row = report.json()["rows"][0]
        assert row["calls"] == 1 and row["cost_cny"] == 1.25 and row["duration_ms"] == 120
    output = client.get("/api/admin/usage.csv?group=user")
    assert output.status_code == 200 and "attachment" in output.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(output.text.lstrip("\ufeff"))))
    assert len(rows) == 3 and any(row[1] == "'=unsafe_formula" for row in rows[1:])
    assert client.get("/api/admin/usage?from=2026-10-22&to=2026-10-21").status_code == 422
    assert client.get("/api/admin/usage?group=invalid").status_code == 422


def test_settings_validate_and_persist_immediately(admin_api):
    client, factory, _, _ = admin_api
    value = client.get("/api/admin/settings").json()
    assert set(value["candidates"]) == {"text", "vision", "image", "video"}
    candidates = value.pop("candidates")
    value["models"]["image"] = next(
        model for model in candidates["image"] if model != value["models"]["image"]
    )
    value["global_daily_budget_cny"] = 15
    response = client.put("/api/admin/settings", json=value)
    assert response.status_code == 200
    assert client.get("/api/admin/settings").json()["models"] == value["models"]
    from app.runtime_settings import get_runtime_settings

    with factory() as session:
        assert get_runtime_settings(session)["models"] == value["models"]
    value["models"]["image"] = "not-a-candidate"
    assert client.put("/api/admin/settings", json=value).status_code == 422
    value["global_daily_budget_cny"] = -1
    assert client.put("/api/admin/settings", json=value).status_code == 422


def test_disable_enable_login_and_writes_and_tier(admin_api):
    client, _, user_id, _ = admin_api
    patched = client.patch(f"/api/admin/users/{user_id}", json={"disabled": True, "tier": "pro"})
    assert patched.status_code == 200 and patched.json()["disabled"] is True
    assert patched.json()["tier"] == "pro" and patched.json()["project_count"] == 1
    credentials = {"username": "admin_test_user", "password": "test-password-123"}
    assert client.post("/api/auth/login", json=credentials).status_code == 403
    app_headers = {"Authorization": "Bearer " + issue_token(user_id)}
    assert client.get("/api/me", headers=app_headers).status_code == 200
    project_input = {
        "title": "禁用后", "brand": "品牌", "brief": "需求", "garment_asset_ids": ["test-garment"]
    }
    response = client.post("/api/projects", json=project_input, headers=app_headers)
    assert response.status_code == 403 and response.json()["error"]["code"] == "USER_DISABLED"
    assert client.patch(f"/api/admin/users/{user_id}", json={"disabled": False}).status_code == 200
    assert client.post("/api/auth/login", json=credentials).status_code == 200
    assert client.post("/api/projects", json=project_input, headers=app_headers).status_code == 200
    assert client.patch(f"/api/admin/users/{user_id}", json={"tier": "unknown"}).status_code == 422
    assert len(client.get("/api/admin/users?q=admin_test_user").json()) == 1
    assert client.get("/api/admin/users?q=missing").json() == []


def _job(factory, user_id, project_id, status="failed", **fields):
    with factory() as session:
        job = Job(
            user_id=user_id, project_id=project_id, kind="image", status=status,
            attempts=3, error="原来的错误", dedupe_key=str(datetime.now(UTC)), **fields,
        )
        session.add(job)
        session.commit()
        return job.id


def test_job_retry_and_cancel_change_worker_queue(admin_api):
    client, factory, user_id, project_id = admin_api
    retry_id = _job(factory, user_id, project_id)
    response = client.post(f"/api/admin/jobs/{retry_id}/retry")
    assert response.status_code == 200 and response.json()["status"] == "queued"
    assert response.json()["attempts"] == 0 and response.json()["error"] is None
    with factory() as session:
        claimed = claim_job(session)
        assert claimed.id == retry_id and claimed.status == "running" and claimed.attempts == 1
    assert client.post(f"/api/admin/jobs/{retry_id}/cancel").status_code == 409
    assert client.post(f"/api/admin/jobs/{retry_id}/retry").status_code == 409
    cancel_id = _job(factory, user_id, project_id, "queued")
    cancelled = client.post(f"/api/admin/jobs/{cancel_id}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "failed"
    assert cancelled.json()["cancelled"] is True
    with factory() as session:
        assert session.get(Job, cancel_id).error == "管理员已取消任务。"
        assert session.scalar(select(Message).where(Message.project_id == project_id)) is not None
        assert claim_job(session) is None
    assert client.post(f"/api/admin/jobs/{cancel_id}/retry").status_code == 409
    assert client.post("/api/admin/jobs/missing/retry").status_code == 404
    jobs = client.get("/api/admin/jobs?status=failed&limit=1").json()
    assert len(jobs) == 1 and jobs[0]["id"] == cancel_id


def test_admin_queue_exposes_photo_script_and_old_jobs_return_null(admin_api):
    client, factory, user_id, project_id = admin_api
    prompt = '50mm，窗光，胶片颗粒\n<svg onload="alert(1)">不要居中 & 保留衣服细节'
    scripted_id = _job(factory, user_id, project_id, payload={"photo_prompt": prompt})
    legacy_id = _job(factory, user_id, project_id)
    response = client.get("/api/admin/jobs")
    assert response.status_code == 200
    rows = {row["id"]: row for row in response.json()}
    assert rows[scripted_id]["photo_prompt"] == prompt
    assert rows[legacy_id]["photo_prompt"] is None
    retried = client.post(f"/api/admin/jobs/{scripted_id}/retry")
    assert retried.status_code == 200 and retried.json()["photo_prompt"] == prompt


def test_admin_photo_script_markup_escapes_payload_and_keeps_line_breaks():
    source = (Path(__file__).resolve().parents[1] / "app/admin_static/index.html").read_text()
    start = source.index('<details class="job-photo-prompt"')
    end = source.index("</details>", start) + len("</details>")
    markup = source[start:end]
    assert '<details class="job-photo-prompt" data-job="${esc(j.id)}"' in markup
    assert "<summary>摄影脚本</summary>" in markup
    assert '<pre>${esc(j.photo_prompt)}</pre>' in markup
    assert '${j.photo_prompt}' not in markup
    assert re.search(r"\.job-photo-prompt pre\s*\{\s*white-space:\s*pre-wrap;", source)


def test_retry_respects_disabled_user_budget_and_unknown_paid_result(admin_api):
    client, factory, user_id, project_id = admin_api
    job_id = _job(factory, user_id, project_id)
    client.patch(f"/api/admin/users/{user_id}", json={"disabled": True})
    assert client.post(f"/api/admin/jobs/{job_id}/retry").status_code == 403
    client.patch(f"/api/admin/users/{user_id}", json={"disabled": False})
    value = client.get("/api/admin/settings").json()
    value.pop("candidates")
    value["global_daily_budget_cny"] = 0
    assert client.put("/api/admin/settings", json=value).status_code == 200
    response = client.post(f"/api/admin/jobs/{job_id}/retry")
    assert response.status_code == 403 and response.json()["error"]["code"] == "BUDGET_EXCEEDED"
    with factory() as session:
        assert session.get(Job, job_id).status == "failed"
        job = session.get(Job, job_id)
        job.result = {"external_request_started": True}
        session.commit()
    response = client.post(f"/api/admin/jobs/{job_id}/retry")
    assert response.status_code == 409 and response.json()["error"]["code"] == "JOB_RESULT_UNKNOWN"


def test_overview_carries_trend_model_share_and_success_rate(admin_api):
    client, _factory, _user_id, _project_id = admin_api
    payload = client.get("/api/admin/overview").json()
    assert len(payload["trend"]) == 7
    assert all({"day", "calls", "cost_cny"} <= set(point) for point in payload["trend"])
    assert isinstance(payload["by_model"], list)
    assert set(payload["jobs"]) == {"queued", "running", "failed", "succeeded", "cancelled"}
    assert payload["success_rate"] is None or 0 <= payload["success_rate"] <= 1
