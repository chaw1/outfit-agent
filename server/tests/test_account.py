"""Account closure contracts, including persistence and authentication boundaries."""

import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import rate_limits
from app.account import LEGAL_VERSION, router
from app.main import app
from app.models import Base, User
from app.security import get_session


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
