"""Real local API/Worker and PostgreSQL, with zero-cost Mock providers."""

import pytest

from app.costs import auto_quote


def body(garment, **extra):
    return {
        "title": "一键出片验收", "brand": "本地品牌", "brief": "记录城市漫步的穿搭",
        "garment_asset_ids": [garment["id"]], **extra,
    }


def test_auto_quote_and_legacy_creation(api, project_assets):
    project, _, _ = project_assets
    assert api.request("GET", "/api/quotes/auto") == auto_quote()
    assert auto_quote()["estimate_points"] > 0
    assert project["mode"] == "guided" and project["style_tags"] == []
    state = api.state(project["id"])
    assert state["mode"] == "guided" and state["auto"] is None
    api.send(project["id"], text="开始")
    assert api.state(project["id"])["pending_action"]["type"] == "choose_direction"


@pytest.mark.parametrize("extra", [
    {"mode": "unknown"}, {"style_tags": ["长" * 13]},
    {"style_tags": ["风格"] * 7}, {"style_tags": [""]},
])
def test_new_creation_fields_validate_without_breaking_old_requests(api, project_assets, extra):
    _, garment, _ = project_assets
    response = api.client.post("/api/projects", json=body(garment, **extra))
    assert response.status_code == 422


def test_auto_worker_finishes_without_client_confirmations(api, project_assets):
    _, garment, model = project_assets
    created = api.request("POST", "/api/projects", json=body(
        garment, mode="auto", style_tags=["街头胶片", "松弛通勤"], model_asset_id=model["id"],
    ))
    project_id = created["id"]
    observed = []

    def completed(state):
        observed.append(state["auto"]["step"])
        assert state["pending_action"] is None
        assert state["mode"] == "auto"
        assert state["style_tags"] == ["街头胶片", "松弛通勤"]
        return state["stage"] == "done"

    state = api.wait(project_id, completed, timeout=90)
    assert state["auto"]["active"] is False and state["auto"]["step"] == "done"
    assert state["auto"]["estimate_points"] == auto_quote()["estimate_points"]
    assert state["video"]["status"] == "succeeded"
    assert state["note"]["image_ids"] == [
        image["id"] for image in state["images"] if image["version"] == 1
    ]
    assert len(state["script"]["shots"]) == 3
    assert api.request("GET", f"/api/projects/{project_id}")["brief"] == created["brief"]
    messages = api.request("GET", f"/api/projects/{project_id}/messages")
    steps = [m for m in messages if m["trace"] and m["trace"]["tool"] == "auto"]
    assert [m["text"] for m in steps] == [
        "正在寻找拍摄方向。", "正在写拍摄脚本。", "正在拍摄这组片。",
        "正在写这组片的笔记。", "正在生成视频。", "全套已出好。",
    ]
    assert all(m["role"] == "assistant" for m in messages)
    listed = next(p for p in api.request("GET", "/api/projects") if p["id"] == project_id)
    assert listed["progress"]["label"] == "全套已出好"


def test_takeover_before_first_decision_stays_guided_and_is_idempotent(api, project_assets):
    _, garment, _ = project_assets
    created = api.request("POST", "/api/projects", json=body(garment, mode="auto"))
    project_id = created["id"]
    state = api.request("POST", f"/api/projects/{project_id}/mode", json={"mode": "guided"})
    assert state["mode"] == "guided"
    if state["auto"]:
        assert state["auto"]["active"] is False
    again = api.request("POST", f"/api/projects/{project_id}/mode", json={"mode": "guided"})
    assert again["mode"] == "guided"
    assert api.client.post(f"/api/projects/{project_id}/mode",
                           json={"mode": "auto"}).status_code == 422
