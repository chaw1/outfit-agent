import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import jwt
import pytest

from app.config import settings
from app.media import signed_url
from app.security import hash_password, issue_token, media_signature, verify_password


def assert_error(response, expected_status):
    assert response.status_code == expected_status
    error = response.json()["error"]
    assert isinstance(error["code"], str) and error["code"]
    assert isinstance(error["message"], str) and error["message"]


def test_passwords_use_salted_bcrypt():
    password = "sample-password-123"
    one, two = hash_password(password), hash_password(password)
    assert one.startswith(("$2b$", "$2a$")) and one != two
    assert verify_password(password, one)
    assert not verify_password("wrong-password", one)
    assert not verify_password("密" * 73, one)


def test_jwt_has_seven_day_expiry():
    user_id = str(uuid4())
    claims = jwt.decode(issue_token(user_id), settings.jwt_secret, algorithms=["HS256"])
    assert claims["sub"] == user_id
    assert claims["exp"] - claims["iat"] == 7 * 24 * 3600


def test_media_signature_binds_asset_and_expiry():
    first, second = str(uuid4()), str(uuid4())
    exp = int(time.time()) + 100
    signature = media_signature(first, exp)
    assert signature != media_signature(second, exp)
    assert signature != media_signature(first, exp + 1)
    parsed = urlsplit(signed_url(first))
    params = parse_qs(parsed.query)
    assert 86400 <= int(params["exp"][0]) - int(time.time()) <= 108000
    assert int(params["exp"][0]) % (6 * 3600) == 0


@pytest.mark.integration
@pytest.mark.parametrize("path", ["/api/me", "/api/projects", "/api/projects/missing/state"])
def test_authentication_required(base_url, path):
    import httpx

    response = httpx.get(base_url + path, trust_env=False)
    assert_error(response, 401)


@pytest.mark.integration
def test_invalid_and_expired_jwt(api):
    assert_error(api.client.get("/api/me", headers={"Authorization": "Bearer invalid"}), 401)
    expired = jwt.encode({
        "sub": str(uuid4()), "exp": datetime.now(UTC) - timedelta(seconds=10),
    }, settings.jwt_secret, algorithm="HS256")
    assert_error(api.client.get("/api/me", headers={"Authorization": f"Bearer {expired}"}), 401)


@pytest.mark.integration
def test_login_and_duplicate_registration(api):
    credentials, user = api.register("login")
    logged = api.request("POST", "/api/auth/login", json=credentials)
    assert logged["user"] == user
    assert "password_hash" not in logged["user"]
    assert_error(api.client.post("/api/auth/login", json={
        **credentials, "password": "a-wrong-password",
    }), 401)
    assert_error(api.client.post("/api/auth/register", json=credentials), 409)


@pytest.mark.integration
@pytest.mark.parametrize("credentials", [
    {"username": "ab", "password": "long-enough-password"},
    {"username": "a" * 33, "password": "long-enough-password"},
    {"username": "valid_user", "password": "1234567"},
])
def test_registration_validation(api, credentials):
    assert_error(api.client.post("/api/auth/register", json=credentials), 422)


@pytest.mark.integration
def test_project_owner_isolation(other_api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    assert project_id not in {p["id"] for p in other_api.request("GET", "/api/projects")}
    for suffix in ("", "/state", "/messages"):
        assert_error(other_api.client.get(f"/api/projects/{project_id}{suffix}"), 404)
    assert_error(other_api.client.post(
        f"/api/projects/{project_id}/messages", json={"text": "你好"},
    ), 404)
    assert_error(other_api.client.delete(f"/api/projects/{project_id}"), 404)


@pytest.mark.integration
def test_cannot_use_another_users_assets(api, other_api, project_assets):
    _, garment, model = project_assets
    own = other_api.upload("jeans.jpg", "garment")
    for payload in (
        {"garment_asset_ids": [garment["id"]]},
        {"garment_asset_ids": [own["id"]], "model_asset_id": model["id"]},
    ):
        response = other_api.client.post("/api/projects", json={
            "title": "隔离验证", "brand": "品牌", "brief": "测试", **payload,
        })
        assert response.status_code in {403, 404, 422}
        assert "error" in response.json()


@pytest.mark.integration
def test_media_capability_expiry_and_tampering(api, project_assets):
    _, asset, _ = project_assets
    # Valid signed media intentionally works without a bearer token for App <Image>.
    response = api.client.get(asset["url"], headers={"Authorization": ""})
    assert response.status_code == 200 and response.content
    expired_url = signed_url(asset["id"], exp=int(time.time()) - 5)
    expired_path = urlsplit(expired_url)
    expired = api.client.get(expired_path.path + "?" + expired_path.query)
    assert_error(expired, 403)
    parsed = urlsplit(asset["url"])
    query = parse_qs(parsed.query)
    query["sig"] = ["0" * 64]
    bad = urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                     urlencode(query, doseq=True), ""))
    assert_error(api.client.get(bad), 403)
    query["sig"] = ["中" * 64]
    unicode_bad = urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                             urlencode(query, doseq=True), ""))
    assert_error(api.client.get(unicode_bad), 403)
    assert_error(api.client.get(parsed.path), 422)


@pytest.mark.integration
def test_invalid_upload_is_rejected(api):
    response = api.client.post("/api/assets", data={"kind": "garment"}, files={
        "file": ("fake.jpg", b"not an image", "image/jpeg"),
    })
    assert_error(response, 415)


@pytest.mark.integration
def test_delete_project_hides_it(api, project_assets):
    project, _, _ = project_assets
    response = api.client.delete(f"/api/projects/{project['id']}")
    assert response.status_code in {200, 204}
    assert_error(api.client.get(f"/api/projects/{project['id']}"), 404)
    assert_error(api.client.get(f"/api/projects/{project['id']}/state"), 404)
    assert project["id"] not in {p["id"] for p in api.request("GET", "/api/projects")}
