"""Direction refresh retains conversation preferences and produces fresh preview work."""

import hashlib
import json

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Asset, Base, Job, Project, UsageLedger, User
from app.providers import ProviderHub
from app.workflow import ALLOWED_TOOLS, Workflow

REFRESH = "换一组方向，保留我刚才说的偏好"


@pytest.fixture
def direction_database(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "deepseek_api_key", "local-transport-placeholder")
    engine = create_engine(f"sqlite:///{tmp_path / 'directions.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        user = User(
            username="direction-refresh", password_hash="unused", nickname="本地测试",
            profile={"style_notes": "不穿高跟鞋"},
        )
        session.add(user)
        session.flush()
        garment = Asset(user_id=user.id, kind="garment", path="unused.png", mime="image/png")
        session.add(garment)
        session.flush()
        project = Project(
            user_id=user.id, title="换一组", brand="本地品牌", brief="夏季穿搭",
            garment_asset_ids=[garment.id],
        )
        session.add(project)
        session.commit()
        yield session, project
    engine.dispose()


def test_mock_refresh_keeps_prior_user_preferences_and_new_previews(direction_database):
    session, project = direction_database
    workflow = Workflow(session, project)
    state = {
        "stage": "direction", "images": [], "job_intents": [],
        "messages": [
            {"role": "user", "content": "要通勤，保留平底鞋"},
            {"role": "assistant", "content": "可以，继续用通勤场景。"},
        ],
        "brief": {"original": project.brief},
        "garments": [{"asset_id": project.garment_asset_ids[0], "category": "衬衫"}],
    }
    state["directions"] = ProviderHub._mock_text(
        "propose_directions", {}, "第一组方向"
    )["options"]
    original_jobs = workflow._preview_directions(state)
    original_ids = {job.id for job in original_jobs}
    original_scenes = {item["scene"] for item in state["directions"]}
    original_prompts = [job.payload["prompt"] for job in original_jobs]
    session.commit()

    refreshed = workflow.handle(state, {"text": REFRESH, "turn_id": "refresh-1"})
    session.commit()
    options = refreshed["directions"]
    assert refreshed["stage"] == "direction"
    assert refreshed["pending_action"]["type"] == "choose_direction"
    assert 2 <= len(options) <= 3
    assert not ({item["scene"] for item in options} & original_scenes)
    assert all("通勤" in item["name"] for item in options)
    assert all("平底鞋" in item["why"] for item in options)
    assert all(item["preview_status"] == "queued" for item in options)

    preview_jobs = session.scalars(select(Job)).all()
    new_jobs = [job for job in preview_jobs if job.id not in original_ids]
    assert len(new_jobs) == len(options)
    assert len({job.dedupe_key for job in preview_jobs}) == len(preview_jobs)
    assert not ({job.payload["prompt"] for job in new_jobs} & set(original_prompts))
    hub = ProviderHub(session, project.id)
    original_media = {
        hashlib.sha256(hub.image(prompt, []).data).hexdigest() for prompt in original_prompts
    }
    new_media = {
        hashlib.sha256(hub.image(job.payload["prompt"], []).data).hexdigest() for job in new_jobs
    }
    assert not (new_media & original_media)
    assert all(row.estimated_cny == 0 for row in session.scalars(select(UsageLedger)))


def test_real_selection_prompt_explains_refresh_and_keeps_history(
    direction_database, monkeypatch
):
    session, project = direction_database
    monkeypatch.setattr(settings, "mock_providers", False)
    context = {
        "stage": "direction",
        "recent_messages": [{"role": "user", "text": "要通勤，不穿高跟鞋"}],
        "directions": ProviderHub._mock_text("propose_directions", {}, "")["options"],
    }
    expected = ProviderHub._mock_text("propose_directions", context, REFRESH)
    requests = []

    def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        system = body["messages"][0]["content"]
        assert "必须选propose_directions" in system
        assert "保留context.recent_messages" in system
        assert "不能把“换一组”当作清空历史偏好" in system
        user = json.loads(body["messages"][-1]["content"])
        assert user["context"]["recent_messages"] == context["recent_messages"]
        assert user["instruction"] == REFRESH
        assert {tool["function"]["name"] for tool in body["tools"]} == ALLOWED_TOOLS["direction"]
        assert body["tool_choice"] == "required"
        return httpx.Response(200, json={
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "propose_directions", "arguments": json.dumps(expected),
            }}]}}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 200},
        })

    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: httpx.Client(transport=httpx.MockTransport(handler))
    )
    name, result = ProviderHub(session, project.id).select_tool(
        sorted(ALLOWED_TOOLS["direction"]), context, REFRESH
    )
    assert name == "propose_directions" and result == expected
    assert len(requests) == 1


def test_mock_second_refresh_changes_scenes_again():
    context = {
        "stage": "direction",
        "recent_messages": [{"role": "user", "text": "要通勤"}],
    }
    _, first = ProviderHub._mock_select_tool(sorted(ALLOWED_TOOLS["direction"]), context, REFRESH)
    _, second = ProviderHub._mock_select_tool(
        sorted(ALLOWED_TOOLS["direction"]), {**context, "directions": first["options"]}, REFRESH
    )
    assert not ({item["scene"] for item in first["options"]}
                & {item["scene"] for item in second["options"]})
    assert all("通勤" in item["name"] for item in second["options"])
