"""A client attempt identifies a replay; a new attempt authorizes fresh work."""

from copy import deepcopy

import pytest
import test_graph_workflow
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from test_graph_workflow import choose_script, succeed_images

from app.errors import AppError
from app.graph import get_graph_state, run_turn
from app.models import Job
from app.runtime_settings import default_runtime_settings, save_runtime_settings
from app.schemas import EditImage, MessageInput
from app.workflow import fingerprint

flow = test_graph_workflow.flow


def generated_images(flow):
    session, project, _, graph = flow
    choose_script(graph, project)
    turn = run_turn(graph, project, None, {"type": "confirm_script"})
    succeed_images(session, project)
    return [job["id"] for job in turn["jobs"]]


def edit_action(parent_id, attempt="attempt-one", **changes):
    action = {"type": "edit_image", "image_id": parent_id, "instruction": "袖口放下来"}
    if attempt is not None:
        action["attempt"] = attempt
    return {**action, **changes}


@pytest.mark.parametrize("status", ["queued", "running", "succeeded", "failed"])
def test_same_attempt_reuses_job_in_every_status_without_requeue_or_text_call(flow, status):
    session, project, _, graph = flow
    ids = generated_images(flow)
    action = edit_action(ids[0])
    initial = run_turn(graph, project, None, deepcopy(action))
    assert initial["jobs"][0]["reused"] is False
    job = session.get(Job, initial["jobs"][0]["id"])
    if status == "succeeded":
        succeed_images(session, project)
    job.status, job.attempts = status, 3
    job.error = "失败原因保留" if status == "failed" else None
    job.result = {"existing_result": "preserved"}
    session.commit()
    before_intents = deepcopy(get_graph_state(graph, project.id)["job_intents"])
    before_calls = list(graph.workflow.providers.calls)

    replay = run_turn(graph, project, None, deepcopy(action))

    assert replay["jobs"][0]["id"] == job.id
    assert replay["jobs"][0]["reused"] is True
    assert replay["jobs"][0]["status"] == status
    assert graph.workflow.providers.calls == before_calls
    assert job.status == status and job.attempts == 3
    assert job.result == {"existing_result": "preserved"}
    assert job.error == ("失败原因保留" if status == "failed" else None)
    assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 1
    assert get_graph_state(graph, project.id)["job_intents"] == before_intents


def test_new_attempt_creates_a_new_task_and_can_replay_independently(flow):
    session, project, _, graph = flow
    ids = generated_images(flow)
    first = run_turn(graph, project, None, edit_action(ids[0]))["jobs"][0]
    second = run_turn(graph, project, None, edit_action(ids[0], "attempt-two"))["jobs"][0]
    assert first["id"] != second["id"]
    assert first["reused"] is False and second["reused"] is False
    first_job, second_job = session.get(Job, first["id"]), session.get(Job, second["id"])
    assert second_job.payload["version"] == first_job.payload["version"] + 1
    replay = run_turn(graph, project, None, edit_action(ids[0]))["jobs"][0]
    assert replay["id"] == first["id"] and replay["reused"] is True
    assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 2


def test_attempt_is_scoped_by_parent_instruction_and_selection(flow):
    _, project, _, graph = flow
    ids = generated_images(flow)
    changes = [
        {},
        {"image_id": ids[1]},
        {"instruction": "背景稍微亮一点"},
        {"region": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}},
        {"region": {"x": 0.4, "y": 0.1, "w": 0.2, "h": 0.2}},
        {"mask_strokes": {"brush": 0.1, "strokes": [[{"x": 0.5, "y": 0.5}]]}},
    ]
    created = []
    for change in changes:
        action = edit_action(ids[0], **change)
        task = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
        assert task["reused"] is False
        repeated = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
        assert repeated["id"] == task["id"] and repeated["reused"] is True
        created.append(task["id"])
    assert len(set(created)) == len(changes)


@pytest.mark.parametrize("selection", [
    {},
    {"region": {"x": 0.1, "y": 0.2, "w": 0.2, "h": 0.3}},
])
def test_no_attempt_keeps_legacy_identity_and_returns_reuse_marker(flow, selection):
    session, project, _, graph = flow
    ids = generated_images(flow)
    action = edit_action(ids[0], None, **selection)
    initial = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
    identity = [ids[0], action["instruction"], selection] if selection else [
        ids[0], action["instruction"],
    ]
    assert session.get(Job, initial["id"]).dedupe_key == (
        f"{project.id}:edit:{fingerprint(identity)}"
    )
    assert initial["reused"] is False
    repeated = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
    assert repeated["id"] == initial["id"] and repeated["reused"] is True
    explicit = run_turn(graph, project, None, edit_action(ids[0], **selection))["jobs"][0]
    assert explicit["id"] != initial["id"] and explicit["reused"] is False


def test_existing_attempt_can_replay_after_budget_is_exhausted_but_new_attempt_cannot(flow):
    session, project, _, graph = flow
    ids = generated_images(flow)
    action = edit_action(ids[0])
    first = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
    config = default_runtime_settings()
    config["tiers"]["free"]["daily_budget_cny"] = 0
    save_runtime_settings(session, config)
    session.commit()
    before_calls = list(graph.workflow.providers.calls)

    replay = run_turn(graph, project, None, deepcopy(action))["jobs"][0]
    assert replay["id"] == first["id"] and replay["reused"] is True
    assert graph.workflow.providers.calls == before_calls
    with pytest.raises(AppError) as error:
        run_turn(graph, project, None, edit_action(ids[0], "fresh-attempt"))
    assert error.value.code == "BUDGET_EXCEEDED"
    assert graph.workflow.providers.calls == before_calls
    assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 1


def test_new_attempt_and_replay_in_note_preserve_note_and_video_confirmation(flow):
    _, project, _, graph = flow
    ids = generated_images(flow)
    run_turn(graph, project, None, {"type": "approve_images", "image_ids": ids[:2]})
    before = get_graph_state(graph, project.id)
    returned = []
    for attempt in ("note-one", "note-one", "note-two"):
        turn = run_turn(graph, project, None, edit_action(ids[0], attempt))
        after = get_graph_state(graph, project.id)
        assert turn["stage"] == "note"
        assert after["note"] == before["note"]
        assert after["pending_action"] == before["pending_action"]
        assert turn["pending_action"]["type"] == "confirm_video"
        returned.append(turn["jobs"][0])
    assert [task["reused"] for task in returned] == [False, True, False]
    assert returned[0]["id"] == returned[1]["id"] != returned[2]["id"]


@pytest.mark.parametrize("attempt", ["a", "1" * 64, None])
def test_attempt_schema_accepts_optional_string_up_to_64_characters(attempt):
    body = MessageInput(action=edit_action("image", attempt))
    assert body.action.attempt == attempt
    encoded = body.model_dump(exclude_none=True)["action"]
    assert encoded.get("attempt") == attempt


@pytest.mark.parametrize("attempt", ["", " ", "1" * 65, 17, True, [], {}])
def test_attempt_schema_rejects_invalid_values(attempt):
    with pytest.raises(ValidationError):
        EditImage.model_validate(edit_action("image", attempt))


def test_attempt_http_schema_preserves_field_and_rejects_extras():
    app = FastAPI()

    @app.post("/messages")
    def messages(body: MessageInput):
        return body.model_dump(exclude_none=True)

    with TestClient(app) as client:
        response = client.post("/messages", json={"action": edit_action("image", "a" * 64)})
        assert response.status_code == 200
        assert response.json()["action"]["attempt"] == "a" * 64
        for action in (
            edit_action("image", "a" * 65),
            edit_action("image", unexpected=True),
            {"type": "approve_images", "image_ids": ["image"], "attempt": "forbidden"},
        ):
            assert client.post("/messages", json={"action": action}).status_code == 422
        assert client.post("/messages", json={
            "action": edit_action("image"), "attempt": "wrong-level",
        }).status_code == 422
