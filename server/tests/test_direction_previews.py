"""Three independent previews stay replay-safe and carry the chosen cover mood."""

from copy import deepcopy

import pytest
import test_graph_workflow
from sqlalchemy import select

from app.errors import AppError
from app.graph import get_graph_state, run_turn
from app.models import Asset, Job
from app.schemas import MessageInput
from app.views import direction_items, refresh_cards

flow = test_graph_workflow.flow


def start(graph, project):
    run_turn(graph, project, "开始", None)
    return get_graph_state(graph, project.id)


def complete(session, project, job):
    asset = Asset(user_id=project.user_id, project_id=project.id, kind="reference",
                  path="preview.png", mime="image/png", source="generated")
    session.add(asset)
    session.flush()
    job.status, job.result_asset_id = "succeeded", asset.id
    session.flush()
    return asset.id


def test_three_distinct_variants_per_direction_and_replay_does_not_requeue(flow):
    session, project, _, graph = flow
    state = start(graph, project)
    jobs = list(session.scalars(select(Job)))
    assert len(jobs) == len(state["directions"]) * 3 == 9
    for direction in state["directions"]:
        group = [job for job in jobs if job.payload["direction_id"] == direction["id"]]
        assert {job.payload["variant"] for job in group} == {"全身街拍", "半身特写", "坐姿侧光"}
        assert len({job.payload["prompt"] for job in group}) == 3
        assert len({job.dedupe_key.rsplit(":", 1)[0] for job in group}) == 1
        assert len(direction["previews"]) == 3
        assert direction["preview_status"] == direction["previews"][0]["status"] == "queued"
    before = {job.id for job in jobs}
    assert {job.id for job in graph.workflow._preview_directions(state)} == before
    assert len(list(session.scalars(select(Job)))) == 9
    assert len(state["job_intents"]) == 9


def test_polling_updates_each_preview_and_first_image_legacy_alias(flow):
    session, project, _, graph = flow
    state = start(graph, project)
    direction = state["directions"][0]
    first, second, third = [session.get(Job, item["id"]) for item in direction["previews"]]
    asset_id = complete(session, project, first)
    second.status, third.status = "running", "failed"
    session.flush()
    original = deepcopy(direction)
    result = direction_items(session, project.id, [direction])[0]
    assert direction == original
    assert [item["status"] for item in result["previews"]] == ["succeeded", "running", "failed"]
    assert asset_id in result["preview_url"] == result["previews"][0]["url"]
    card = refresh_cards([{"type": "directions", "options": [direction]}], session, project.id)[0]
    assert card["regenerate_estimate_points"] == 45
    assert card["options"][0]["previews"][2]["status"] == "failed"


@pytest.mark.parametrize("selected", [None, 1, 2])
def test_selected_preview_survives_checkpoint_and_reaches_script_context_and_cover(
    flow, monkeypatch, selected
):
    session, project, _, graph = flow
    state = start(graph, project)
    direction = state["directions"][0]
    preview = direction["previews"][selected or 0]
    job = session.get(Job, preview["id"])
    asset_id = complete(session, project, job)
    contexts = []
    original = graph.workflow.providers.text

    def capture(tool, context, instruction=""):
        if tool == "write_script":
            contexts.append(deepcopy(context))
        return original(tool, context, instruction)

    monkeypatch.setattr(graph.workflow.providers, "text", capture)
    action = {"type": "choose_direction", "direction_id": direction["id"]}
    if selected is not None:
        action["preview_id"] = preview["id"]
    run_turn(graph, project, None, action)
    checkpoint = get_graph_state(graph, project.id)
    assert checkpoint["chosen_preview_id"] == preview["id"]
    assert contexts[0]["chosen_preview"]["variant"] == preview["variant"]
    assert job.payload["description"] in contexts[0]["cover_inspiration"]
    assert preview["variant"] in checkpoint["script"]["shots"][0]["camera"]
    assert checkpoint["script"]["preview_id"] == preview["id"]
    result = run_turn(graph, project, None, {"type": "confirm_script"})
    cover = session.get(Job, result["jobs"][0]["id"])
    assert cover.payload["reference_asset_ids"] == [
        *cover.payload["garment_asset_ids"], asset_id, project.model_asset_id,
    ]
    assert "构图与光线以灵感图为基调" in cover.payload["prompt"]
    assert preview["variant"] in cover.payload["prompt"]
    assert "不作为服装或人物身份依据" in cover.payload["prompt"]
    assert "最后一张参考图为本人照片" in cover.payload["prompt"]
    for item in result["jobs"][1:]:
        assert asset_id not in session.get(Job, item["id"]).payload["reference_asset_ids"]


def test_preview_from_another_direction_cannot_be_selected(flow):
    _, project, _, graph = flow
    state = start(graph, project)
    with pytest.raises(AppError, match="这个方向"):
        run_turn(graph, project, None, {"type": "choose_direction",
                 "direction_id": state["directions"][0]["id"],
                 "preview_id": state["directions"][1]["previews"][0]["id"]})


def test_retry_one_failed_preview_keeps_other_two_and_replays_same_attempt(flow):
    session, project, _, graph = flow
    state = start(graph, project)
    direction = state["directions"][0]
    previews = direction["previews"]
    failed = session.get(Job, previews[1]["id"])
    for item in (previews[0], previews[2]):
        complete(session, project, session.get(Job, item["id"]))
    failed.status = "failed"
    session.flush()
    action = {"type": "retry_preview", "direction_id": direction["id"],
              "preview_id": previews[1]["id"], "attempt": "retry-1"}
    assert MessageInput(action=action).action.preview_id == previews[1]["id"]
    first = run_turn(graph, project, None, action)
    retried = session.get(Job, first["jobs"][0]["id"])
    assert retried.id != failed.id
    assert retried.payload["preview_id"] == failed.id
    assert len(list(session.scalars(select(Job)))) == 10
    run_turn(graph, project, None, action)
    assert len(list(session.scalars(select(Job)))) == 10
    projected = direction_items(session, project.id, [direction])[0]
    assert [item["status"] for item in projected["previews"]] == [
        "succeeded", "queued", "succeeded",
    ]
    complete(session, project, retried)
    run_turn(graph, project, None, action)
    assert len(list(session.scalars(select(Job)))) == 10
    with pytest.raises(AppError, match="未失败"):
        run_turn(graph, project, None, {**action, "attempt": "retry-2"})


def test_explicit_preview_selection_waits_for_a_completed_image(flow):
    _, project, _, graph = flow
    state = start(graph, project)
    direction = state["directions"][0]
    with pytest.raises(AppError, match="生成完成"):
        run_turn(graph, project, None, {"type": "choose_direction",
                 "direction_id": direction["id"], "preview_id": direction["previews"][0]["id"]})


def test_state_response_keeps_selected_preview_and_refreshes_nested_urls(flow, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main
    from app.models import User

    session, project, _, graph = flow
    state = start(graph, project)
    direction = state["directions"][0]
    preview = direction["previews"][1]
    complete(session, project, session.get(Job, preview["id"]))
    run_turn(graph, project, None, {"type": "choose_direction",
             "direction_id": direction["id"], "preview_id": preview["id"]})
    session.commit()
    monkeypatch.setattr(main, "project_lock", lambda *args, **kwargs: False)
    monkeypatch.setattr(main, "graph_for", lambda *args: (graph, graph.workflow))
    monkeypatch.setitem(main.app.dependency_overrides, main.get_session, lambda: session)
    monkeypatch.setitem(main.app.dependency_overrides, main.current_user,
                        lambda: session.get(User, project.user_id))
    client = TestClient(main.app)
    try:
        response = client.get(f"/api/projects/{project.id}/state")
    finally:
        client.close()
    assert response.status_code == 200
    data = response.json()
    assert data["chosen_preview_id"] == preview["id"]
    assert data["script"]["preview_id"] == preview["id"]
    assert data["directions"][0]["previews"][1]["url"]
