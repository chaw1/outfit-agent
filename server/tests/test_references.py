"""Reference ownership and style survive API serialization and graph restarts."""

import json
from copy import deepcopy
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from test_graph_workflow import LocalProvider

from app.graph import build_graph, get_graph_state, run_turn
from app.main import app
from app.models import Asset, Base, Job, Project, User
from app.security import get_session, issue_token
from app.views import refresh_cards
from app.workflow import Workflow

STYLE = {
    "scene": "夜晚街头霓虹", "lighting": "蓝紫霓虹侧光", "composition": "低机位全身构图",
    "mood": "都市电影感", "palette": "蓝紫与暖红", "style_tags": ["夜景", "霓虹", "电影感"],
}
PROJECT_BODY = {
    "title": "风格参考", "brand": "个人测试品牌", "brief": "夏季穿搭",
    "garment_asset_ids": ["garment"],
}


class ReferenceProvider(LocalProvider):
    def __init__(self, session, project_id):
        super().__init__(session, project_id)
        self.contexts = []

    def analyze_references(self, assets):
        self.calls.append("analyze_references")
        return [{"asset_id": asset.id, **STYLE} for asset in assets]

    def select_tool(self, tools, context, instruction=""):
        self.contexts.append(context)
        return super().select_tool(tools, context, instruction)

    def text(self, tool, context, instruction=""):
        self.contexts.append(context)
        return super().text(tool, context, instruction)


@pytest.fixture
def reference_session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'references.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(username="reference-owner", password_hash="unused", nickname="博主")
        other = User(username="reference-other", password_hash="unused", nickname="他人")
        session.add_all([user, other])
        session.flush()
        for asset_id, owner, kind, source in (
            ("garment", user, "garment", "upload"),
            ("reference-1", user, "reference", "upload"),
            ("reference-2", user, "reference", "upload"),
            ("reference-3", user, "reference", "upload"),
            ("reference-other", other, "reference", "upload"),
            ("reference-generated", user, "reference", "generated"),
        ):
            session.add(Asset(
                id=asset_id, user_id=owner.id, kind=kind, source=source,
                path="unused.png", mime="image/png",
            ))
        session.commit()
        yield session, user
    engine.dispose()


@pytest.fixture
def reference_api(reference_session):
    session, user = reference_session

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


def test_reference_assets_persist_in_create_get_and_list_in_requested_order(reference_api):
    client, session = reference_api
    refs = ["reference-3", "reference-1", "reference-2"]
    created = client.post("/api/projects", json={**PROJECT_BODY, "reference_asset_ids": refs})
    assert created.status_code == 200
    project_id = created.json()["id"]
    assert created.json()["reference_asset_ids"] == refs
    assert session.get(Project, project_id).reference_asset_ids == refs
    assert client.get(f"/api/projects/{project_id}").json()["reference_asset_ids"] == refs
    assert client.get("/api/projects").json()[0]["reference_asset_ids"] == refs
    legacy = client.post("/api/projects", json=PROJECT_BODY)
    assert legacy.status_code == 200 and legacy.json()["reference_asset_ids"] == []


@pytest.mark.parametrize("references", [
    ["reference-other"], ["reference-generated"], ["garment"], ["missing"],
    ["reference-1", "reference-1"], [""], ["  "], None,
    ["reference-1", "reference-2", "reference-3", "reference-other"],
])
def test_reference_assets_reject_invalid_input_without_creating_project(reference_api, references):
    client, session = reference_api
    response = client.post("/api/projects", json={
        **PROJECT_BODY, "reference_asset_ids": references,
    })
    assert response.status_code == 422
    assert "error" in response.json()
    assert session.scalar(select(func.count()).select_from(Project)) == 0


def test_reference_style_reaches_cards_context_previews_and_formal_prompts_after_restart(
    reference_session, monkeypatch,
):
    session, user = reference_session
    monkeypatch.setattr("app.workflow.ProviderHub", ReferenceProvider)
    project = Project(user_id=user.id, **PROJECT_BODY, reference_asset_ids=["reference-1"])
    session.add(project)
    session.commit()
    saver = InMemorySaver()
    graph = build_graph(saver, Workflow(session, project))
    streamed = []
    result = run_turn(graph, project, "帮我想方向", None,
                      emit=lambda event, data: streamed.append((event, data)))
    cards = {card["type"]: card for card in result["cards"]}
    assert set(cards) == {"garments", "references", "directions"}
    assert cards["references"]["items"][0]["asset_id"] == "reference-1"
    assert cards["references"]["items"][0]["style_tags"] == STYLE["style_tags"]
    assert cards["references"]["items"][0]["url"].split("?")[0].endswith("/reference-1")
    assert [data["type"] for event, data in streamed if event == "card"][:2] == [
        "garments", "references",
    ]
    state = get_graph_state(graph, project.id)
    for field in ("scene", "lighting", "composition", "mood", "palette"):
        assert STYLE[field] in state["brief"]["summary"]
        assert STYLE[field] in graph.workflow.providers.contexts[0]["reference_style_summary"]
    previews = list(session.scalars(select(Job)))
    assert len(previews) in {2, 3}
    assert all("夜晚街头霓虹" in job.payload["prompt"] for job in previews)
    assert all(job.payload["reference_asset_ids"] == ["garment"] for job in previews)
    assert "夜晚街头霓虹" in json.dumps(cards["directions"], ensure_ascii=False)

    restarted = build_graph(saver, Workflow(session, project))
    scripted = run_turn(restarted, project, None, {
        "type": "choose_direction", "direction_id": state["directions"][0]["id"],
    })
    assert "analyze_references" not in restarted.workflow.providers.calls
    context = restarted.workflow.providers.contexts[-1]
    assert context["references"][0]["asset_id"] == "reference-1"
    assert "夜晚街头霓虹" in json.dumps(scripted["cards"], ensure_ascii=False)
    run_turn(restarted, project, None, {"type": "confirm_script"})
    jobs = list(session.scalars(select(Job)))
    formal = [job for job in jobs if job.payload.get("purpose") != "preview"]
    assert len(formal) >= 3
    assert all("夜晚街头霓虹" in job.payload["prompt"] for job in formal)


def test_no_reference_keeps_original_cards_context_and_garment_prompt(
    reference_session, monkeypatch,
):
    session, user = reference_session
    monkeypatch.setattr("app.workflow.ProviderHub", ReferenceProvider)
    project = Project(user_id=user.id, **PROJECT_BODY)
    session.add(project)
    session.commit()
    graph = build_graph(InMemorySaver(), Workflow(session, project))
    result = run_turn(graph, project, "帮我想方向", None)
    assert {card["type"] for card in result["cards"]} == {"garments", "directions"}
    assert "analyze_references" not in graph.workflow.providers.calls
    state = get_graph_state(graph, project.id)
    assert "references" not in state
    context = graph.workflow._context(state)
    assert "references" not in context and "reference_style_summary" not in context
    assert graph.workflow._reference_prompt(state) == ""
    assert graph.workflow._garment_prompt(state, ["garment"]) == (
        "原衣服1：白色待确认衬衫。严格保持原衣服版型、颜色、面料、纽扣、口袋、logo，不得增删或改变。"
        "吊牌、价签、织标贴纸、衣架、包装袋不属于衣服，必须忽略并从成品画面去除。"
    )


@pytest.mark.parametrize("kind", ["garments", "references"])
def test_uploaded_card_urls_refresh_after_expiry_without_mutating_stored_cards(
    reference_session, monkeypatch, kind,
):
    session, _ = reference_session
    cards = [{
        "id": f"project:{kind}", "type": kind,
        "items": [{"asset_id": "reference-1", "url": "https://media.test/expired",
                   "style_tags": ["夜晚街头", "霓虹"]}],
    }]
    original = deepcopy(cards)
    now = [100]
    monkeypatch.setattr("app.views.signed_url", lambda asset_id: (
        f"https://media.test/{asset_id}?exp={now[0] + 86400}&sig=renewed-{now[0]}"
    ))
    first = refresh_cards(cards, session, "project")
    now[0] += 86401
    refreshed = refresh_cards(cards, session, "project")
    assert first[0]["items"][0]["url"].endswith("exp=86500&sig=renewed-100")
    assert refreshed[0]["items"][0]["url"].endswith("exp=172901&sig=renewed-86501")
    assert refreshed[0]["items"][0]["asset_id"] == "reference-1"
    assert refreshed[0]["items"][0]["style_tags"] == original[0]["items"][0]["style_tags"]
    assert refreshed[0]["id"] == original[0]["id"]
    assert cards == original


@pytest.mark.integration
def test_reference_card_streamed_and_read_back_through_public_http(api):
    garment = api.upload("shirt.jpg", "garment")
    reference = api.upload("model.jpg", "reference")
    refs = [reference["id"]]
    project = api.request("POST", "/api/projects", json={
        **PROJECT_BODY, "garment_asset_ids": [garment["id"]], "reference_asset_ids": refs,
    })
    assert project["reference_asset_ids"] == refs
    events = api.send(project["id"], text="结合参考图给我方向")
    cards = [event["data"] for event in events if event["event"] == "card"]
    reference_card = next(card for card in cards if card["type"] == "references")
    assert [item["asset_id"] for item in reference_card["items"]] == refs
    assert reference_card["items"][0]["style_tags"]
    messages = api.request("GET", f"/api/projects/{project['id']}/messages")
    stored = next(card for card in messages[-1]["cards"] if card["type"] == "references")
    assert stored["id"] == reference_card["id"] and stored["type"] == "references"
    assert len(stored["items"]) == len(reference_card["items"])
    for saved, streamed in zip(stored["items"], reference_card["items"], strict=True):
        assert {key: value for key, value in saved.items() if key != "url"} == {
            key: value for key, value in streamed.items() if key != "url"
        }
        assert urlsplit(saved["url"]).path == urlsplit(streamed["url"]).path
        readable = api.client.get(saved["url"])
        assert readable.status_code == 200 and readable.headers["content-type"].startswith("image/")
    state = api.state(project["id"])
    assert "霓虹" in json.dumps(state["directions"], ensure_ascii=False)
    chosen = state["directions"][0]["id"]
    api.send(project["id"], action={"type": "choose_direction", "direction_id": chosen})
    assert "霓虹" in json.dumps(api.state(project["id"])["script"], ensure_ascii=False)
