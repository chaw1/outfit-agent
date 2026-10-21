"""Unverified edit results require explicit adoption before entering final media."""

from copy import deepcopy

import pytest
import test_graph_workflow
from test_graph_workflow import choose_script, succeed_images

from app.errors import AppError
from app.graph import build_graph, get_graph_state, run_turn
from app.models import Asset, Job
from app.providers import ProviderHub
from app.workflow import Workflow

flow = test_graph_workflow.flow

REQUESTED_CHANGE = "衬衫塞进裤腰"
FAILED_REASON = "衣摆仍然外放，没有塞进裤腰"


def generated_images(flow):
    session, project, _, graph = flow
    choose_script(graph, project)
    generated = run_turn(graph, project, None, {"type": "confirm_script"})
    succeed_images(session, project)
    return [job["id"] for job in generated["jobs"]]


def completed_edit(flow, parent_id, *, passed=False, instruction=REQUESTED_CHANGE):
    session, project, _, graph = flow
    edited = run_turn(graph, project, None, {
        "type": "edit_image", "image_id": parent_id, "instruction": instruction,
    })
    edit_id = edited["jobs"][0]["id"]
    succeed_images(session, project)
    job = session.get(Job, edit_id)
    if passed is not None:
        job.result = {"edit_check": {
            "passed": passed,
            "reason": "衣摆已按要求塞入裤腰" if passed else FAILED_REASON,
        }}
    session.commit()
    return edit_id


def test_unverified_image_rejected_with_shot_and_reason_without_consuming_pause(flow):
    session, project, _, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[1])
    before = get_graph_state(graph, project.id)
    calls = list(graph.workflow.providers.calls)

    with pytest.raises(AppError) as error:
        run_turn(graph, project, None, {
            "type": "approve_images", "image_ids": [ids[0], failed_id],
        })

    assert error.value.code == "unverified_image"
    assert FAILED_REASON in error.value.message
    assert "2" in error.value.message
    assert session.get(Job, failed_id).status == "succeeded"
    assert graph.workflow.providers.calls == calls
    after = get_graph_state(graph, project.id)
    assert after.get("note") == before.get("note")
    assert after["stage"] == "images"
    snapshot = graph.get_state({"configurable": {"thread_id": project.id}})
    assert snapshot.next == ("await_images",)
    assert any(task.interrupts for task in snapshot.tasks)


def test_explicit_adoption_persists_only_selected_failed_ids_in_note(flow):
    session, project, saver, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[1])
    another_failed_id = completed_edit(flow, ids[2], instruction="袖口放下来")
    selected = [failed_id, ids[0]]
    turn = run_turn(graph, project, None, {
        "type": "approve_images",
        "image_ids": selected,
        "accept_unverified": [ids[0], failed_id],
    })

    assert turn["stage"] == "note"
    assert turn["cards"][0]["image_ids"] == selected
    assert turn["cards"][0]["accepted_unverified_ids"] == [failed_id]
    assert another_failed_id not in turn["cards"][0]["accepted_unverified_ids"]
    assert session.get(Job, failed_id).status == "succeeded"
    session.commit()
    restarted = build_graph(saver, Workflow(session, project))
    note = get_graph_state(restarted, project.id)["note"]
    assert note["image_ids"] == selected
    assert note["accepted_unverified_ids"] == [failed_id]


def test_note_reselection_refreshes_images_and_text_rewrite_keeps_adoption(flow):
    _, project, _, graph = flow
    ids = generated_images(flow)
    original = run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": ids[:2],
    })
    failed_id = completed_edit(flow, ids[0])
    selected = [failed_id, ids[1]]
    refreshed = run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": selected, "accept_unverified": [failed_id],
    })
    assert refreshed["cards"][0]["image_ids"] != original["cards"][0]["image_ids"]
    assert refreshed["cards"][0]["image_ids"] == selected
    assert refreshed["cards"][0]["accepted_unverified_ids"] == [failed_id]

    rewritten = run_turn(graph, project, "标题改成：清爽通勤灵感", None)
    assert rewritten["cards"][0]["title"] == "清爽通勤灵感"
    assert rewritten["cards"][0]["image_ids"] == selected
    assert rewritten["cards"][0]["accepted_unverified_ids"] == [failed_id]
    assert get_graph_state(graph, project.id)["note"]["accepted_unverified_ids"] == [failed_id]

    with pytest.raises(AppError) as error:
        run_turn(graph, project, None, {"type": "approve_images", "image_ids": selected})
    assert error.value.code == "unverified_image"
    assert get_graph_state(graph, project.id)["note"]["image_ids"] == selected

    restored = run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": ids[:2],
    })
    assert restored["cards"][0]["image_ids"] == ids[:2]
    assert restored["cards"][0]["accepted_unverified_ids"] == []


def test_video_source_must_belong_to_current_note_selection(flow):
    session, project, _, graph = flow
    ids = generated_images(flow)
    run_turn(graph, project, None, {"type": "approve_images", "image_ids": ids[:2]})
    failed_id = completed_edit(flow, ids[0])
    run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": [failed_id, ids[1]],
        "accept_unverified": [failed_id],
    })

    with pytest.raises(AppError) as error:
        run_turn(graph, project, None, {"type": "confirm_video", "image_id": ids[0]})
    assert error.value.code == "image_not_selected"
    assert get_graph_state(graph, project.id).get("video") is None

    video = run_turn(graph, project, None, {"type": "confirm_video", "image_id": failed_id})
    assert video["stage"] == "video"
    payload = session.get(Job, video["jobs"][0]["id"]).payload
    assert payload["image_id"] == failed_id
    assert payload["image_asset_id"] == session.get(Job, failed_id).result_asset_id


def test_legacy_note_without_adoption_cannot_use_unverified_video_source(flow):
    _, project, _, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[0])
    run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": [failed_id], "accept_unverified": [failed_id],
    })
    legacy_note = deepcopy(get_graph_state(graph, project.id)["note"])
    legacy_note.pop("accepted_unverified_ids")
    graph.update_state(
        {"configurable": {"thread_id": project.id}},
        {"note": legacy_note},
        as_node="execute_stage_tool",
    )
    before_calls = list(graph.workflow.providers.calls)

    with pytest.raises(AppError) as error:
        run_turn(graph, project, None, {"type": "confirm_video", "image_id": failed_id})

    assert error.value.code == "unverified_image"
    assert FAILED_REASON in error.value.message
    assert graph.workflow.providers.calls == before_calls
    state = get_graph_state(graph, project.id)
    assert state["note"] == legacy_note
    assert state.get("video") is None
    assert state["stage"] == "note"


@pytest.mark.parametrize("target_stage", ["video", "done"])
def test_finalized_note_text_rewrite_retains_explicit_adoption(flow, target_stage):
    session, project, _, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[0])
    run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": [failed_id], "accept_unverified": [failed_id],
    })
    video = run_turn(graph, project, None, {"type": "confirm_video", "image_id": failed_id})
    video_id = video["jobs"][0]["id"]
    if target_stage == "done":
        asset = Asset(
            user_id=project.user_id, project_id=project.id, kind="reference",
            path="video.mp4", mime="video/mp4", source="generated",
        )
        session.add(asset)
        session.flush()
        job = session.get(Job, video_id)
        job.status, job.result_asset_id = "succeeded", asset.id
        session.commit()

    revised = run_turn(graph, project, "标题改成：这套清爽通勤", None)
    assert revised["stage"] == target_stage
    assert revised["cards"][0]["image_ids"] == [failed_id]
    assert revised["cards"][0]["accepted_unverified_ids"] == [failed_id]
    assert revised["jobs"] == []
    assert get_graph_state(graph, project.id)["video"]["job_id"] == video_id


@pytest.mark.parametrize("passed", [None, True])
def test_legacy_or_verified_images_still_approve_without_acceptance(flow, passed):
    _, project, _, graph = flow
    ids = generated_images(flow)
    edit_id = completed_edit(flow, ids[0], passed=passed)
    note = run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": [edit_id, ids[1]],
    })["cards"][0]
    assert note["image_ids"] == [edit_id, ids[1]]
    assert note.get("accepted_unverified_ids", []) == []
    assert isinstance(note["title"], str) and 1 <= len(note["title"]) <= 20
    assert isinstance(note["body"], str) and note["body"].strip()
    assert isinstance(note["tags"], list) and 5 <= len(note["tags"]) <= 8
    assert all(isinstance(tag, str) and tag.strip() for tag in note["tags"])
    if passed is None:
        assert REQUESTED_CHANGE not in note["body"]


def test_free_text_model_cannot_invent_unverified_adoption(flow, monkeypatch):
    _, project, _, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[0])

    def select_note(tools, context, instruction):
        result = ProviderHub._mock_text(
            "write_note", {**context, "selected_image_ids": [failed_id]}, instruction,
        )
        # A model tool result cannot stand in for the user's explicit action.
        return "write_note", {**result, "accept_unverified": [failed_id]}

    monkeypatch.setattr(graph.workflow.providers, "select_tool", select_note)
    with pytest.raises(AppError) as error:
        run_turn(graph, project, "用这张写一篇笔记", None)
    assert error.value.code == "unverified_image"
    assert get_graph_state(graph, project.id).get("note") is None


@pytest.mark.parametrize("passed", [False, None])
def test_unconfirmed_request_is_separate_from_visual_facts_in_note_context(
    flow, monkeypatch, passed,
):
    _, project, _, graph = flow
    ids = generated_images(flow)
    run_turn(graph, project, None, {"type": "approve_images", "image_ids": ids[:2]})
    failed_id = completed_edit(flow, ids[0], passed=passed)
    provider = graph.workflow.providers
    original = provider.select_tool
    contexts = []

    def capture(tools, context, instruction):
        contexts.append(deepcopy(context))
        return original(tools, context, instruction)

    monkeypatch.setattr(provider, "select_tool", capture)
    run_turn(graph, project, "标题改成：清爽通勤灵感", None)
    edited = next(item for item in contexts[-1]["images"] if item["id"] == failed_id)
    assert edited["requested_change"] == REQUESTED_CHANGE
    assert isinstance(edited["confirmed_visual_facts"], list)
    assert all(REQUESTED_CHANGE not in fact for fact in edited["confirmed_visual_facts"])
    assert any(edited["scene"] in fact for fact in edited["confirmed_visual_facts"])


def test_passing_child_does_not_turn_failed_ancestor_request_into_visual_fact(flow, monkeypatch):
    _, project, _, graph = flow
    ids = generated_images(flow)
    failed_id = completed_edit(flow, ids[0])
    passed_change = "背景稍微亮一点"
    child_id = completed_edit(flow, failed_id, passed=True, instruction=passed_change)
    provider = graph.workflow.providers
    original = provider.text
    contexts = []

    def capture(tool, context, instruction=""):
        if tool == "write_note":
            contexts.append(deepcopy(context))
        return original(tool, context, instruction)

    monkeypatch.setattr(provider, "text", capture)
    run_turn(graph, project, None, {"type": "approve_images", "image_ids": [child_id]})
    edited = contexts[-1]["images"][0]
    assert edited["requested_change"] == passed_change
    assert any(passed_change in fact for fact in edited["confirmed_visual_facts"])
    assert all(REQUESTED_CHANGE not in fact for fact in edited["confirmed_visual_facts"])


def test_confirmed_facts_keep_latest_repeated_change_after_opposite_edit(flow):
    _, project, _, graph = flow
    ids = generated_images(flow)
    tucked_id = completed_edit(flow, ids[0], passed=True)
    untucked_id = completed_edit(flow, tucked_id, passed=True, instruction="衣摆放下来")
    latest_id = completed_edit(flow, untucked_id, passed=True)

    context = graph.workflow._context(get_graph_state(graph, project.id))
    latest = next(item for item in context["images"] if item["id"] == latest_id)
    assert latest["requested_change"] == REQUESTED_CHANGE
    assert latest["confirmed_visual_facts"][-1] == REQUESTED_CHANGE


@pytest.mark.parametrize("passed", [False, True])
def test_verified_or_explicitly_adopted_request_can_be_a_visual_fact(flow, monkeypatch, passed):
    _, project, _, graph = flow
    ids = generated_images(flow)
    edit_id = completed_edit(flow, ids[0], passed=passed)
    provider = graph.workflow.providers
    original = provider.text
    contexts = []

    def capture(tool, context, instruction=""):
        if tool == "write_note":
            contexts.append(deepcopy(context))
        return original(tool, context, instruction)

    monkeypatch.setattr(provider, "text", capture)
    run_turn(graph, project, None, {
        "type": "approve_images", "image_ids": [edit_id],
        **({"accept_unverified": [edit_id]} if not passed else {}),
    })
    edited = next(item for item in contexts[-1]["images"] if item["id"] == edit_id)
    assert edited["requested_change"] == REQUESTED_CHANGE
    assert any(REQUESTED_CHANGE in fact for fact in edited["confirmed_visual_facts"])
