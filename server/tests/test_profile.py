"""Profile privacy, partial updates, Shanghai-day budgets and agent preference memory."""

import json
from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.main import app
from app.models import Asset, Base, Project, UsageLedger, User
from app.profile import default_model_asset_id, patch_user
from app.providers import SYSTEM_PROMPT, ProviderHub
from app.runtime_settings import day_bounds, default_runtime_settings, save_runtime_settings
from app.schemas import UserProfilePatch
from app.security import get_session, issue_token
from app.views import user_dict
from app.workflow import Workflow


@pytest.fixture
def profile_session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'profile.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(username="profile-owner", nickname="原昵称", password_hash="unused")
        other = User(username="other-owner", nickname="他人", password_hash="unused")
        session.add_all([user, other])
        session.flush()
        for asset_id, owner, kind, source in (
            ("first-model", user, "model", "upload"),
            ("second-model", user, "model", "upload"),
            ("other-model", other, "model", "upload"),
            ("generated-model", user, "model", "generated"),
            ("garment", user, "garment", "upload"),
        ):
            session.add(Asset(id=asset_id, user_id=owner.id, kind=kind, source=source,
                              path="unused.png", mime="image/png"))
        session.commit()
        yield session, user
    engine.dispose()


def test_profile_partial_merge_clear_and_default_order(profile_session):
    session, user = profile_session
    assert user_dict(user, session)["profile"] == {"model_asset_ids": []}
    patch_user(session, user, UserProfilePatch.model_validate({"nickname": "新昵称", "profile": {
        "model_asset_ids": ["second-model", "first-model"],
        "height_cm": 168, "body_notes": "肩宽", "style_notes": "喜欢松弛感，不穿高跟鞋",
    }}))
    assert default_model_asset_id(session, user) == "second-model"
    patch_user(session, user, UserProfilePatch.model_validate({"profile": {"body_notes": None}}))
    assert user.nickname == "新昵称"
    assert "body_notes" not in user.profile
    assert user.profile["height_cm"] == 168
    assert user.profile["model_asset_ids"] == ["second-model", "first-model"]
    patch_user(session, user, UserProfilePatch.model_validate({"profile": {"model_asset_ids": []}}))
    assert default_model_asset_id(session, user) is None
    assert user.profile["style_notes"] == "喜欢松弛感，不穿高跟鞋"


@pytest.mark.parametrize("asset_id", ["other-model", "generated-model", "garment", "missing"])
def test_profile_rejects_wrong_owner_kind_source_without_partial_write(profile_session, asset_id):
    session, user = profile_session
    with pytest.raises(AppError, match="本人上传"):
        patch_user(session, user, UserProfilePatch.model_validate({
            "nickname": "不应写入", "profile": {"model_asset_ids": [asset_id]},
        }))
    assert user.nickname == "原昵称" and user.profile == {}


@pytest.mark.parametrize("body", [
    {"nickname": None}, {"profile": None}, {"nickname": ""},
    {"profile": {"model_asset_ids": None}},
    {"profile": {"model_asset_ids": ["first-model", "first-model"]}},
    {"profile": {"height_cm": float("inf")}},
])
def test_invalid_profile_schema(body):
    with pytest.raises(ValidationError):
        UserProfilePatch.model_validate(body)


def test_me_budget_matches_runtime_tier_and_includes_reserved_calls(profile_session):
    session, user = profile_session
    config = default_runtime_settings()
    config["tiers"]["pro"]["daily_budget_cny"] = 7.5
    save_runtime_settings(session, config)
    user.tier = "pro"
    start, end = day_bounds()
    for when, cost, status in (
        (start - timedelta(microseconds=1), "8", "succeeded"),
        (start, "1.2", "succeeded"),
        (end - timedelta(microseconds=1), "0.3", "reserved"),
        (end, "9", "failed"),
    ):
        session.add(UsageLedger(user_id=user.id, model="test", kind="text", created_at=when,
                                estimated_cny=Decimal(cost), status=status))
    session.commit()
    me = user_dict(user, session)
    assert me["tier"] == "pro" and me["daily_budget_cny"] == 7.5
    assert me["today_cost_cny"] == 1.5


def test_workflow_loads_current_profile_and_mock_contents_obey_it(profile_session):
    session, user = profile_session
    project = Project(user_id=user.id, title="偏好记忆", brand="品牌", brief="日常穿搭",
                      garment_asset_ids=["garment"])
    session.add(project)
    session.commit()
    workflow = Workflow(session, project)
    assert workflow._context({})["style_notes"] == ""
    patch_user(session, user, UserProfilePatch.model_validate({"profile": {
        "style_notes": "喜欢松弛感，不穿高跟鞋", "height_cm": 168,
    }}))
    context = workflow._context({"garments": [{"asset_id": "garment"}]})
    assert context["profile"]["height_cm"] == 168
    assert context["style_notes"] == user.profile["style_notes"]
    directions = ProviderHub._mock_text("propose_directions", context, "")
    assert all("松弛感" in item["why"] and "平底鞋" in item["why"]
               for item in directions["options"])
    script = ProviderHub._mock_text("write_script", context, "")
    assert all("松弛感" in shot["caption"] and "平底鞋" in shot["pose"]
               for shot in script["shots"])


def test_real_adapter_includes_preference_system_instruction(profile_session, monkeypatch):
    session, user = profile_session
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "test-placeholder")
    monkeypatch.setattr(settings, "model_budget_cny", 12)
    context = {"profile": {"style_notes": "喜欢松弛感，不穿高跟鞋"},
               "style_notes": "喜欢松弛感，不穿高跟鞋"}

    def handler(request):
        payload = json.loads(request.content)
        assert payload["messages"][0]["content"] == SYSTEM_PROMPT
        assert "context.style_notes" in SYSTEM_PROMPT
        assert json.loads(payload["messages"][1]["content"])["context"] == context
        result = ProviderHub._mock_text("propose_directions", context, "")
        return httpx.Response(200, json={
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "propose_directions", "arguments": json.dumps(result),
            }}]}}], "usage": {"prompt_tokens": 100, "completion_tokens": 100},
        })

    monkeypatch.setattr(ProviderHub, "_client", lambda _: httpx.Client(
        transport=httpx.MockTransport(handler)
    ))
    result = ProviderHub(session).text("propose_directions", context)
    assert "松弛感" in result["reply"]


@pytest.fixture
def profile_api(profile_session):
    session, user = profile_session

    def override():
        with Session(session.get_bind()) as request_session:
            yield request_session

    app.dependency_overrides[get_session] = override
    client = TestClient(app, headers={"Authorization": "Bearer " + issue_token(user.id)})
    try:
        yield client, session
    finally:
        client.close()
        app.dependency_overrides.pop(get_session, None)


def test_me_profile_route_and_project_default_photo(profile_api):
    client, session = profile_api
    response = client.get("/api/me")
    assert response.status_code == 200
    assert {"tier", "daily_budget_cny", "today_cost_cny", "profile"} <= response.json().keys()
    patched = client.patch("/api/me", json={"nickname": "博主", "profile": {
        "model_asset_ids": ["second-model", "first-model"],
        "height_cm": 168, "style_notes": "喜欢松弛感，不穿高跟鞋",
    }})
    assert patched.status_code == 200 and patched.json()["nickname"] == "博主"
    patched = client.patch("/api/me", json={"profile": {"body_notes": "肩宽"}})
    assert patched.json()["profile"]["height_cm"] == 168
    project_body = {"title": "默认形象", "brand": "品牌", "brief": "需求",
                    "garment_asset_ids": ["garment"]}
    response = client.post("/api/projects", json=project_body)
    assert response.status_code == 200
    project = session.get(Project, response.json()["id"])
    assert project.model_asset_id == "second-model"
    explicit = client.post("/api/projects", json={**project_body, "model_asset_id": "first-model"})
    assert explicit.status_code == 200
    assert session.get(Project, explicit.json()["id"]).model_asset_id == "first-model"


def test_me_rejects_other_users_model_photo_in_chinese(profile_api):
    client, _ = profile_api
    response = client.patch("/api/me", json={"profile": {"model_asset_ids": ["other-model"]}})
    assert response.status_code == 422
    assert "本人上传" in response.json()["error"]["message"]
    assert client.get("/api/me").json()["profile"]["model_asset_ids"] == []
