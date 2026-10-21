"""Account lifecycle exercised through the dedicated local Mock HTTP API."""

import re
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

from scripts.e2e import API

pytestmark = pytest.mark.integration


@pytest.fixture
def account_api(base_url):
    client = API(base_url)
    try:
        yield client
    finally:
        client.close()


def _credentials():
    return {"username": f"account10_{uuid4().hex[:16]}", "password": f"password-{uuid4().hex}"}


def _register(api, *, legacy=False, credentials=None):
    credentials = credentials or _credentials()
    body = dict(credentials)
    if not legacy:
        body["agreed_legal_version"] = "2026-10-21"
    response = api.client.post("/api/auth/register", json=body)
    assert response.status_code == 200
    result = response.json()
    _assert_recovery_code(result["recovery_code"])
    api.client.headers["Authorization"] = f"Bearer {result['token']}"
    return credentials, result


def _assert_recovery_code(code):
    assert isinstance(code, str)
    assert re.fullmatch(r"[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}", code)


def _assert_secret_absent(response, code):
    assert response.status_code == 200
    assert code not in response.text
    payload = response.json()
    assert payload.get("recovery_code") is None
    if "user" in payload:
        assert payload["user"].get("recovery_code") is None


def _assert_token_rejected(api, token):
    response = api.client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def _assert_recovery_failed(response):
    assert 400 <= response.status_code < 500 and response.status_code != 429
    assert response.json()["error"]["code"] == "RECOVERY_FAILED"


def _assert_limited_by_username(api, username):
    for _ in range(32):
        response = api.client.post("/api/auth/recover", json={
            "username": username,
            "recovery_code": "0000-0000-0000",
            "new_password": "never-applied-password",
        })
        if response.status_code == 429:
            assert response.json()["error"]["code"] == "RATE_LIMITED"
            assert int(response.headers["retry-after"]) > 0
            return
        _assert_recovery_failed(response)
    pytest.fail("Repeated failed recovery attempts were not rate limited")


@pytest.mark.parametrize("legacy", [False, True], ids=["agreed-version", "old-client"])
def test_registration_issues_recovery_code_only_once(account_api, legacy):
    credentials, registered = _register(account_api, legacy=legacy)
    code = registered["recovery_code"]
    assert registered["user"]["username"] == credentials["username"]
    assert "recovery_code" not in registered["user"]
    _assert_secret_absent(account_api.client.get("/api/me"), code)
    login = account_api.client.post("/api/auth/login", json=credentials)
    _assert_secret_absent(login, code)
    assert login.json()["user"]["id"] == registered["user"]["id"]


def test_recovery_changes_password_revokes_sessions_and_rotates_code(account_api):
    credentials, registered = _register(account_api)
    logged_in = account_api.request("POST", "/api/auth/login", json=credentials)
    new_password = f"recovered-{uuid4().hex}"
    response = account_api.client.post("/api/auth/recover", json={
        "username": credentials["username"],
        "recovery_code": registered["recovery_code"],
        "new_password": new_password,
    })
    assert response.status_code == 200
    recovered = response.json()
    assert recovered["user"]["id"] == registered["user"]["id"]
    _assert_recovery_code(recovered["recovery_code"])
    assert recovered["recovery_code"] != registered["recovery_code"]
    _assert_token_rejected(account_api, registered["token"])
    _assert_token_rejected(account_api, logged_in["token"])
    account_api.client.headers["Authorization"] = f"Bearer {recovered['token']}"
    _assert_secret_absent(account_api.client.get("/api/me"), recovered["recovery_code"])
    assert account_api.client.post("/api/auth/login", json=credentials).status_code == 401
    login = account_api.client.post("/api/auth/login", json={
        "username": credentials["username"], "password": new_password,
    })
    _assert_secret_absent(login, recovered["recovery_code"])
    old_code = account_api.client.post("/api/auth/recover", json={
        "username": credentials["username"],
        "recovery_code": registered["recovery_code"],
        "new_password": "must-not-be-applied",
    })
    _assert_recovery_failed(old_code)
    second = account_api.client.post("/api/auth/recover", json={
        "username": credentials["username"],
        "recovery_code": recovered["recovery_code"],
        "new_password": f"recovered-again-{uuid4().hex}",
    })
    assert second.status_code == 200
    _assert_recovery_code(second.json()["recovery_code"])
    assert second.json()["recovery_code"] != recovered["recovery_code"]
    _assert_token_rejected(account_api, recovered["token"])


def test_recovery_errors_hide_account_existence_and_limit_each_username(account_api):
    credentials, registered = _register(account_api)
    unknown_username = f"missing10_{uuid4().hex[:16]}"
    failures = []
    for username in [credentials["username"], unknown_username]:
        response = account_api.client.post("/api/auth/recover", json={
            "username": username,
            "recovery_code": "0000-0000-0000",
            "new_password": "never-applied-password",
        })
        _assert_recovery_failed(response)
        failures.append((response.status_code, response.json()))
    assert failures[0] == failures[1]
    _assert_limited_by_username(account_api, credentials["username"])
    _assert_limited_by_username(account_api, unknown_username)
    assert account_api.client.post("/api/auth/login", json=credentials).status_code == 200
    _assert_secret_absent(account_api.client.get("/api/me"), registered["recovery_code"])

    independent, other = _register(account_api)
    response = account_api.client.post("/api/auth/recover", json={
        "username": independent["username"],
        "recovery_code": other["recovery_code"],
        "new_password": "another-account-new-password",
    })
    assert response.status_code == 200


def test_recovery_code_regeneration_requires_password_and_replaces_old_code(account_api):
    credentials, registered = _register(account_api)
    rejected = account_api.client.post("/api/me/recovery-code", json={"password": "wrong-password"})
    assert 400 <= rejected.status_code < 500
    assert "recovery_code" not in rejected.json()
    response = account_api.client.post("/api/me/recovery-code", json={
        "password": credentials["password"],
    })
    assert response.status_code == 200
    rotated = response.json()["recovery_code"]
    _assert_recovery_code(rotated)
    assert rotated != registered["recovery_code"]
    _assert_secret_absent(account_api.client.get("/api/me"), rotated)
    old_code = account_api.client.post("/api/auth/recover", json={
        "username": credentials["username"],
        "recovery_code": registered["recovery_code"],
        "new_password": "must-not-be-applied",
    })
    _assert_recovery_failed(old_code)
    recovered = account_api.client.post("/api/auth/recover", json={
        "username": credentials["username"], "recovery_code": rotated,
        "new_password": f"rotated-code-password-{uuid4().hex}",
    })
    assert recovered.status_code == 200
    assert recovered.json()["user"]["id"] == registered["user"]["id"]


def test_password_change_checks_current_password_and_replaces_all_sessions(account_api):
    credentials, registered = _register(account_api)
    other_session = account_api.request("POST", "/api/auth/login", json=credentials)
    new_password = f"changed-{uuid4().hex}"
    denied = account_api.client.post("/api/me/password", json={
        "current_password": "wrong-password", "new_password": new_password,
    })
    assert 400 <= denied.status_code < 500
    assert account_api.client.get("/api/me").status_code == 200
    assert account_api.client.post("/api/auth/login", json=credentials).status_code == 200
    response = account_api.client.post("/api/me/password", json={
        "current_password": credentials["password"], "new_password": new_password,
    })
    assert response.status_code == 200
    changed = response.json()
    assert changed["token"]
    _assert_token_rejected(account_api, registered["token"])
    _assert_token_rejected(account_api, other_session["token"])
    account_api.client.headers["Authorization"] = f"Bearer {changed['token']}"
    me = account_api.client.get("/api/me")
    assert me.status_code == 200 and me.json()["id"] == registered["user"]["id"]
    assert account_api.client.post("/api/auth/login", json=credentials).status_code == 401
    assert account_api.client.post("/api/auth/login", json={
        "username": credentials["username"], "password": new_password,
    }).status_code == 200


def test_deletion_releases_username_revokes_login_and_removes_projects_and_media(account_api):
    credentials, registered = _register(account_api)
    garment = account_api.upload("shirt.jpg", "garment")
    model = account_api.upload("model.jpg", "model")
    unused = account_api.upload("shirt.jpg", "reference")
    projects = [account_api.request("POST", "/api/projects", json={
        "title": f"注销清理验证{i}", "brand": "本地品牌", "brief": "仅验证账号清理",
        "garment_asset_ids": [garment["id"]], "model_asset_id": model["id"],
    }) for i in range(2)]
    media_paths = []
    for asset in [garment, model, unused]:
        # Signed URLs may use another configured port; retain the capability but use this API.
        parsed = urlsplit(asset["url"])
        media_path = parsed.path + ("?" + parsed.query if parsed.query else "")
        assert media_path.startswith("/media/")
        media_paths.append(media_path)
        assert account_api.client.get(media_path).status_code == 200
    denied = account_api.client.request("DELETE", "/api/me", json={"password": "wrong-password"})
    assert 400 <= denied.status_code < 500
    assert account_api.client.get("/api/me").status_code == 200
    for project in projects:
        assert account_api.client.get(f"/api/projects/{project['id']}").status_code == 200

    response = account_api.client.request("DELETE", "/api/me", json={
        "password": credentials["password"],
    })
    assert response.status_code in {200, 204}
    _assert_token_rejected(account_api, registered["token"])
    assert account_api.client.post("/api/auth/login", json=credentials).status_code == 401
    for path in media_paths:
        assert account_api.client.get(path).status_code == 404

    _, replacement = _register(account_api, credentials=credentials)
    assert replacement["user"]["id"] != registered["user"]["id"]
    assert account_api.request("GET", "/api/projects") == []
    for project in projects:
        assert account_api.client.get(f"/api/projects/{project['id']}").status_code == 404
