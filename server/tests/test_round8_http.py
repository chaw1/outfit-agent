"""Round-eight contracts exercised only against this project's local Mock stack."""

import json
import os
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy.engine import make_url

from scripts.e2e import cards

pytestmark = pytest.mark.integration


@pytest.fixture
def round8_database_url(base_url):
    del base_url  # The shared fixture first proves the dedicated API uses Mock providers.
    url = make_url(os.environ.get(
        "TEST_DATABASE_URL", "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
    ))
    assert url.host in {"localhost", "127.0.0.1"} and url.port == 18432, (
        "Round-eight fixture writes are restricted to this project's local PostgreSQL"
    )
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def _job_event(events):
    jobs = [event["data"] for event in events if event["event"] == "job"]
    assert len(jobs) == 1
    return jobs[0]


def _assert_direction_quote(card):
    assert 2 <= len(card["options"]) <= 3
    quote = card["regenerate_estimate_cny"]
    assert isinstance(quote, (int, float)) and not isinstance(quote, bool) and quote > 0


def _mark_owned_edit_unverified(database_url, project, user, job_id, reason):
    with psycopg.connect(database_url) as connection:
        owned = connection.execute(
            "SELECT j.id, j.kind, j.status, j.result_asset_id, p.title, u.username "
            "FROM jobs j JOIN projects p ON p.id = j.project_id AND p.user_id = j.user_id "
            "JOIN users u ON u.id = j.user_id "
            "WHERE j.project_id = %s AND j.user_id = %s AND j.id = %s FOR UPDATE OF j",
            (project["id"], user["id"], job_id),
        ).fetchall()
        assert len(owned) == 1
        row = owned[0]
        assert row[:3] == (job_id, "edit", "succeeded") and row[3]
        assert row[4:] == (project["title"], user["username"])
        result = connection.execute(
            "UPDATE jobs SET result = jsonb_set(COALESCE(result, '{}'::jsonb), "
            "'{edit_check}', %s::jsonb, true) "
            "WHERE project_id = %s AND user_id = %s AND id = %s "
            "AND kind = 'edit' AND status = 'succeeded' AND result_asset_id IS NOT NULL",
            (json.dumps({"passed": False, "reason": reason}), project["id"], user["id"], job_id),
        )
        assert result.rowcount == 1


def test_direction_regeneration_quote_survives_refresh_and_message_readback(api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    initial = api.send(project_id, text="夏季新品，通勤穿搭，不穿高跟鞋")
    first_card = cards(initial, "directions")[0]
    _assert_direction_quote(first_card)
    api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)

    refreshed = api.send(project_id, text="换一组方向，保留我刚才说的偏好")
    second_card = cards(refreshed, "directions")[0]
    _assert_direction_quote(second_card)
    assert {item["id"] for item in first_card["options"]}.isdisjoint(
        item["id"] for item in second_card["options"]
    )
    api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)

    messages = api.request("GET", f"/api/projects/{project_id}/messages")
    stored = [
        card for message in messages for card in message["cards"]
        if card["type"] == "directions"
    ]
    assert len(stored) == 2
    for actual, expected in zip(stored, [first_card, second_card], strict=True):
        _assert_direction_quote(actual)
        assert actual["regenerate_estimate_cny"] == expected["regenerate_estimate_cny"]


def test_attempt_replays_and_explicit_unverified_acceptance_persist(
    api, project_assets, round8_database_url,
):
    project, _, _ = project_assets
    project_id = project["id"]
    user = api.request("GET", "/api/me")
    api.send(project_id, text="夏季新品，想要松弛感")
    state = api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)
    api.send(project_id, action={
        "type": "choose_direction", "direction_id": state["directions"][0]["id"],
    })
    generated = api.send(project_id, action={"type": "confirm_script"})
    original_ids = [event["data"]["id"] for event in generated if event["event"] == "job"]
    assert len(original_ids) >= 3
    api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)

    instruction = "衬衫塞进裤腰"
    action = {
        "type": "edit_image", "image_id": original_ids[0],
        "instruction": instruction, "attempt": str(uuid4()),
    }
    first = _job_event(api.send(project_id, action=action))
    assert first["reused"] is False
    api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)
    replay = _job_event(api.send(project_id, action=action))
    assert replay["id"] == first["id"] and replay["reused"] is True
    second = _job_event(api.send(project_id, action={**action, "attempt": str(uuid4())}))
    assert second["id"] != first["id"] and second["reused"] is False
    api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)

    reason = "本地回归核对：衣摆仍然外放"
    _mark_owned_edit_unverified(round8_database_url, project, user, first["id"], reason)
    state = api.state(project_id)
    failed_check = next(image for image in state["images"] if image["id"] == first["id"])
    assert failed_check["status"] == "succeeded"
    assert failed_check["edit_check"] == {"passed": False, "reason": reason}
    image_ids = [first["id"], original_ids[1]]
    denied = api.client.post(f"/api/projects/{project_id}/messages", json={
        "action": {"type": "approve_images", "image_ids": image_ids},
    })
    assert denied.status_code == 200 and "event: error" in denied.text
    errors = [
        json.loads(block.split("data: ", 1)[1])
        for block in denied.text.split("\n\n") if block.startswith("event: error\n")
    ]
    assert len(errors) == 1 and errors[0]["code"] == "unverified_image"
    assert "镜头1" in errors[0]["message"] and reason in errors[0]["message"]
    assert not api.state(project_id)["note"]

    approved = api.send(project_id, action={
        "type": "approve_images", "image_ids": image_ids,
        "accept_unverified": [first["id"]],
    })
    assert cards(approved, "note")[0]["accepted_unverified_ids"] == [first["id"]]
    state = api.state(project_id)
    assert state["stage"] == "note" and state["note"]["image_ids"] == image_ids
    assert state["note"]["accepted_unverified_ids"] == [first["id"]]
    assert instruction in state["note"]["body"]

    api.send(project_id, text="标题改成：轻松通勤日常")
    rewritten = api.state(project_id)["note"]
    assert rewritten["title"] == "轻松通勤日常"
    assert rewritten["accepted_unverified_ids"] == [first["id"]]
    api.send(project_id, action={
        "type": "approve_images", "image_ids": list(reversed(image_ids)),
        "accept_unverified": [first["id"]],
    })
    reselected = api.state(project_id)["note"]
    assert reselected["image_ids"] == list(reversed(image_ids))
    assert reselected["accepted_unverified_ids"] == [first["id"]]
