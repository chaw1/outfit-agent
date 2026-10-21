"""Public-contract checks for transparent turns, refreshing and text-only rewrites."""

import json

from scripts.e2e import cards


def assert_trace(api, project_id, events, tool, can_regenerate):
    assert events[-2]["event"] == "trace" and events[-1]["event"] == "done"
    message_id = events[-1]["data"]["message_id"]
    messages = api.request("GET", f"/api/projects/{project_id}/messages")
    message = next(item for item in messages if item["id"] == message_id)
    assert message["trace"] == events[-2]["data"]
    assert message["trace"]["tool"] == tool
    assert message["trace"]["model"] == "deepseek-flash"
    assert message["trace"]["cost_cny"] == 0
    assert message["trace"]["duration_ms"] >= 0 and message["trace"]["steps"]
    assert message["can_regenerate"] is can_regenerate
    return message, messages


def test_direction_refresh_traces_and_safe_regeneration(api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    initial = api.send(project_id, text="要通勤，不穿高跟鞋")
    initial_message, _ = assert_trace(api, project_id, initial, "propose_directions", False)
    original = cards(initial, "directions")[0]["options"]
    first_state = api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)
    assert all(item["preview_status"] == "succeeded" for item in first_state["directions"])
    refreshed = api.send(project_id, text="换一组方向，保留我刚才说的偏好")
    assert_trace(api, project_id, refreshed, "propose_directions", False)
    options = cards(refreshed, "directions")[0]["options"]
    assert 2 <= len(options) <= 3
    assert {item["id"] for item in options}.isdisjoint(item["id"] for item in original)
    assert "通勤" in json.dumps(options, ensure_ascii=False)
    second_state = api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)
    assert {item["preview_url"].split("?")[0] for item in second_state["directions"]}.isdisjoint(
        item["preview_url"].split("?")[0] for item in first_state["directions"]
    )
    script_events = api.send(project_id, action={
        "type": "choose_direction", "direction_id": options[0]["id"],
    })
    script, before = assert_trace(api, project_id, script_events, "write_script", True)
    state = api.state(project_id)
    assert state["pending_action"]["estimated_cost_cny"] == len(state["script"]["shots"]) * 0.6
    me = api.request("GET", "/api/me")
    assert state["budget"] == {
        "tier": me["tier"], "daily_budget_cny": me["daily_budget_cny"],
        "daily_budget_points": me["daily_budget_points"],
        "today_cost_points": me["today_cost_points"],
        "remaining_points": round(max(0, me["daily_budget_cny"] - me["today_cost_cny"]) * 10, 1),
        "today_cost_cny": me["today_cost_cny"],
        "remaining_cny": max(0, me["daily_budget_cny"] - me["today_cost_cny"]),
    }
    rewritten = api.send(project_id, action={
        "type": "regenerate_reply", "message_id": script["id"],
    })
    replacement, after = assert_trace(api, project_id, rewritten, "chat", True)
    assert replacement["id"] == script["id"] and len(before) == len(after)
    assert replacement["text"] != script["text"]
    assert replacement["cards"] == script["cards"]
    assert {item["event"] for item in rewritten} == {"token", "trace", "done"}
    unchanged = api.state(project_id)
    assert unchanged["script"] == state["script"]
    assert unchanged["active_jobs"] == [] and unchanged["stage"] == "script"
    denied = api.client.post(f"/api/projects/{project_id}/messages", json={
        "action": {"type": "regenerate_reply", "message_id": initial_message["id"]},
    })
    assert "event: error" in denied.text and "不能重新回复" in denied.text
    generated = api.send(project_id, action={"type": "confirm_script"})
    assert_trace(api, project_id, generated, "generate_images", False)
    final = api.wait(project_id, lambda current: not current["active_jobs"], timeout=30)
    assert final["images"]
    messages = api.request("GET", f"/api/projects/{project_id}/messages")
    assert all(item["trace"] for item in messages if item["role"] == "assistant")
    worker = messages[-1]
    assert worker["trace"]["tool"] == "generate_images" and not worker["can_regenerate"]


def test_regenerate_rejects_cross_project_messages(api, project_assets):
    project, garment, model = project_assets
    first = api.send(project["id"], text="开始")
    project2 = api.request("POST", "/api/projects", json={
        "title": "另一项目", "brand": "测试", "brief": "夏季", "garment_asset_ids": [garment["id"]],
        "model_asset_id": model["id"],
    })
    response = api.client.post(f"/api/projects/{project2['id']}/messages", json={
        "action": {"type": "regenerate_reply", "message_id": first[-1]["data"]["message_id"]},
    })
    assert "message_not_found" in response.text
