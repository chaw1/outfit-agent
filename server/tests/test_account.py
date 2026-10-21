"""Account closure contracts, including persistence and authentication boundaries."""

import re
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import account, rate_limits, security
from app.account import LEGAL_VERSION, router
from app.config import settings
from app.main import app
from app.models import Base, User
from app.security import get_session, verify_password


@pytest.fixture
def account_api(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'account.sqlite'}")
    Base.metadata.create_all(engine)
    rate_limits.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    client = TestClient(app)
    try:
        yield client, factory
    finally:
        client.close()
        app.dependency_overrides.pop(get_session, None)
        engine.dispose()


def test_legal_documents_are_public_complete_and_versioned():
    client = TestClient(app)
    try:
        index = client.get("/api/legal")
        assert index.status_code == 200
        assert {row["kind"] for row in index.json()} == {"terms", "privacy", "disclaimer"}
        for summary in index.json():
            assert summary["version"] == LEGAL_VERSION == "2026-10-21"
            response = client.get("/api/legal/" + summary["kind"])
            assert response.status_code == 200
            document = response.json()
            assert {key: document[key] for key in summary} == summary
            assert 400 <= len(re.sub(r"\s|[#*`>-]", "", document["markdown"])) <= 900
            assert "衣序（演示版）" in document["markdown"]
            assert "97000945@qq.com" in document["markdown"]
        assert client.get("/api/legal/missing").status_code == 404
    finally:
        client.close()


@pytest.mark.parametrize("version", [None, "", LEGAL_VERSION])
def test_registration_records_explicit_consent_and_accepts_legacy_requests(account_api, version):
    client, factory = account_api
    body = {"username": "account-owner", "password": "initial-password", "nickname": "本人"}
    if version is not None:
        body["agreed_legal_version"] = version
    response = client.post("/api/auth/register", json=body)
    assert response.status_code == 200
    assert response.json()["user"]["nickname"] == "本人"
    with factory() as session:
        user = session.scalar(select(User).where(User.username == body["username"]))
        assert user.legal_version == (version or None)
        assert bool(user.legal_agreed_at) == bool(version)
    assert client.post("/api/auth/register", json=body).status_code == 409
    assert client.post("/api/auth/login", json={
        "username": body["username"], "password": body["password"],
    }).status_code == 200


def test_registration_has_exactly_one_runtime_route_and_matching_openapi():
    matches = [route for route in [*app.routes, *router.routes] if (
        getattr(route, "path", None) == "/api/auth/register" and "POST" in route.methods
    )]
    assert len(matches) == 1
    schema = app.openapi()
    ref = schema["paths"]["/api/auth/register"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"]["$ref"].rsplit("/", 1)[1]
    assert "agreed_legal_version" in schema["components"]["schemas"][ref]["properties"]


def register(client):
    response = client.post("/api/auth/register", json={
        "username": "account-owner", "password": "initial-password",
    })
    assert response.status_code == 200
    result = response.json()
    client.headers["Authorization"] = "Bearer " + result["token"]
    return result


def test_only_recovery_code_hash_is_persisted_and_no_query_exposes_it(account_api):
    client, factory = account_api
    result = register(client)
    code = result["recovery_code"]
    assert re.fullmatch(r"[a-z0-9]{4}(-[a-z0-9]{4}){2}", code)
    assert client.get("/api/me").status_code == 200
    with factory() as session:
        user = session.get(User, result["user"]["id"])
        assert user.recovery_code_hash != code
        assert verify_password(code.replace("-", ""), user.recovery_code_hash)
        assert code not in repr(user.__dict__)
    for response in (
        client.get("/api/me"), client.post("/api/auth/login", json={
            "username": "account-owner", "password": "initial-password",
        }),
    ):
        assert response.status_code == 200
        assert "recovery_code" not in response.text
        assert code not in response.text


def test_recovery_revokes_tokens_even_within_the_same_second(account_api, monkeypatch):
    client, factory = account_api
    start = datetime.now(UTC).replace(microsecond=100_000)

    class Clock(datetime):
        value = start

        @classmethod
        def now(cls, tz=None):
            return cls.value

    monkeypatch.setattr(security, "datetime", Clock)
    result = register(client)
    claims = jwt.decode(result["token"], settings.jwt_secret, algorithms=["HS256"])
    assert claims["iat"] == start.timestamp()
    cutoff = start + timedelta(microseconds=100_000)
    monkeypatch.setattr(account, "utcnow", lambda: cutoff)
    Clock.value = start + timedelta(microseconds=200_000)
    recovered = client.post("/api/auth/recover", json={
        "username": "account-owner", "recovery_code": result["recovery_code"].upper(),
        "new_password": "recovered-password",
    })
    assert recovered.status_code == 200
    assert recovered.headers["cache-control"] == "no-store"
    new = recovered.json()
    assert new["recovery_code"] != result["recovery_code"]
    assert client.get("/api/me").status_code == 401
    client.headers["Authorization"] = "Bearer " + new["token"]
    assert client.get("/api/me").status_code == 200
    legacy_token = jwt.encode({
        "sub": result["user"]["id"], "iat": int(start.timestamp()),
        "exp": int(start.timestamp()) + 3600,
    }, settings.jwt_secret, algorithm="HS256")
    assert client.get("/api/me", headers={
        "Authorization": "Bearer " + legacy_token,
    }).status_code == 401
    with factory() as session:
        user = session.get(User, result["user"]["id"])
        assert user.password_updated_at.replace(tzinfo=UTC) == cutoff
        assert verify_password("recovered-password", user.password_hash)
        assert not verify_password("initial-password", user.password_hash)
        assert verify_password(new["recovery_code"].replace("-", ""), user.recovery_code_hash)
    reused = client.post("/api/auth/recover", json={
        "username": "account-owner", "recovery_code": result["recovery_code"],
        "new_password": "never-applied-password",
    })
    assert reused.status_code == 401 and reused.json()["error"]["code"] == "RECOVERY_FAILED"


def test_failed_recovery_does_not_reset_password_and_is_limited_by_username(
    account_api, monkeypatch,
):
    client, _ = account_api
    monkeypatch.setattr(settings, "rate_limit_recover", 2)
    result = register(client)
    for username in ("account-owner", "unknown-user"):
        for _ in range(2):
            response = client.post("/api/auth/recover", json={
                "username": username, "recovery_code": "0000-0000-0000",
                "new_password": "never-applied-password",
            })
            assert response.status_code == 401
            assert response.json() == {"error": {
                "code": "RECOVERY_FAILED", "message": "用户名或恢复码不正确",
            }}
        limited = client.post("/api/auth/recover", json={
            "username": username, "recovery_code": result["recovery_code"],
            "new_password": "never-applied-password",
        })
        assert limited.status_code == 429 and "Retry-After" in limited.headers
    assert client.post("/api/auth/login", json={
        "username": "account-owner", "password": "initial-password",
    }).status_code == 200


def test_legacy_user_without_code_can_set_one_after_password_verification(account_api):
    client, factory = account_api
    result = register(client)
    with factory() as session:
        session.get(User, result["user"]["id"]).recovery_code_hash = None
        session.commit()
    denied = client.post("/api/me/recovery-code", json={"password": "wrong-password"})
    assert denied.status_code == 401
    rotated = client.post("/api/me/recovery-code", json={"password": "initial-password"})
    assert rotated.status_code == 200
    assert rotated.headers["cache-control"] == "no-store"
    response = client.post("/api/auth/recover", json={
        "username": "account-owner", "recovery_code": rotated.json()["recovery_code"],
        "new_password": "recovered-password",
    })
    assert response.status_code == 200
