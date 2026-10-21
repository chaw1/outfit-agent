"""Automatic decisions use the real graph with local models and database rows."""

import pytest
import test_graph_workflow
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auto_mode import advance_auto, auto_info, take_over, tick_auto_project, tick_auto_projects
from app.costs import auto_quote
from app.graph import build_graph, get_graph_state, run_turn
from app.models import Asset, Job, Message, Project, User
from app.runtime_settings import default_runtime_settings, save_runtime_settings
from app.workflow import Workflow

flow = test_graph_workflow.flow


@pytest.fixture
def auto_flow(flow):
    session, project, saver, graph = flow
    project.mode = "auto"
    project.style_tags = ["街头胶片", "松弛通勤"]
    session.commit()
    return session, project, saver, graph


def advance(session, project, graph):
    changed = advance_auto(session, project, graph, Workflow(session, project))
    session.commit()
    state = get_graph_state(graph, project.id)
    if project.mode == "auto":
        assert state.get("pending_action") is None
    return changed, state


def complete_jobs(session, project):
    """Publish valid generated assets, leaving image verification test-specific."""
    jobs = session.scalars(select(Job).where(Job.project_id == project.id)).all()
    for job in jobs:
        if job.status not in {"queued", "running"}:
            continue
        video = job.kind == "video"
        asset = Asset(
            user_id=project.user_id,
            project_id=project.id,
            kind="reference" if video else "image",
            path="generated.mp4" if video else "generated.png",
            mime="video/mp4" if video else "image/png",
            source="generated",
        )
        session.add(asset)
        session.flush()
        job.status, job.result_asset_id = "succeeded", asset.id
    session.commit()
    return jobs


def reach_images(session, project, graph):
    assert advance(session, project, graph)[1]["stage"] == "direction"
    complete_jobs(session, project)
    assert advance(session, project, graph)[1]["stage"] == "script"
    assert advance(session, project, graph)[1]["stage"] == "images"


def automatic_messages(session, project):
    return session.scalars(select(Message).where(
        Message.project_id == project.id, Message.trace["tool"].as_string() == "auto",
    )).all()


def test_auto_recommended_direction_all_v1_and_steps_finish_without_pending(auto_flow, monkeypatch):
    session, project, _, graph = auto_flow
    original_brief = project.brief
    contexts = []
    original_text = test_graph_workflow.LocalProvider.text

    def recommend_second(self, tool, context, instruction=""):
        if tool in {"propose_directions", "write_script"}:
            contexts.append((tool, context))
        result = original_text(self, tool, context, instruction)
        if tool == "propose_directions":
            for index, option in enumerate(result["options"]):
                option["recommended"] = index == 1
        return result

    monkeypatch.setattr(test_graph_workflow.LocalProvider, "text", recommend_second)
    steps = []
    for expected_stage in ("direction", "script", "images", "note", "video", "done"):
        changed, state = advance(session, project, graph)
        assert changed and state["stage"] == expected_stage
        steps.append(state["auto"]["step"])
        assert state["mode"] == "auto" and state["style_tags"] == project.style_tags
        if expected_stage == "direction":
            assert state["directions"][1]["recommended"] is True
        if expected_stage == "script":
            assert state["chosen_direction_id"] == state["directions"][1]["id"]
        if expected_stage == "note":
            originals = session.scalars(select(Job).where(
                Job.project_id == project.id, Job.kind == "image",
                Job.payload["purpose"].as_string().is_(None),
            )).all()
            by_shot = {job.payload["shot_id"]: job.id for job in originals}
            assert state["note"]["image_ids"] == [
                by_shot[shot["id"]] for shot in state["script"]["shots"]
            ]
        if expected_stage == "video":
            video = session.get(Job, state["video"]["job_id"])
            assert video.payload["image_id"] == state["note"]["image_ids"][0]
        complete_jobs(session, project)

    assert steps == ["directions", "script", "images", "note", "video", "done"]
    assert project.stage == "done" and project.brief == original_brief
    assert [tool for tool, _ in contexts] == ["propose_directions", "write_script"]
    assert all(context["style_tags"] == project.style_tags for _, context in contexts)
    assert all(original_brief in context["brief"]["original"] for _, context in contexts)
    info = auto_info(project, state)
    assert info["active"] is False
    assert info["estimate_points"] == auto_quote()["estimate_points"] > 0
    announcements = automatic_messages(session, project)
    assert len(announcements) == 6 and all(message.role == "assistant" for message in announcements)
    before = len(session.scalars(select(Job)).all()), len(announcements)
    assert advance(session, project, graph)[0] is False
    after = len(session.scalars(select(Job)).all()), len(automatic_messages(session, project))
    assert after == before


def test_missing_recommendation_defaults_to_first(auto_flow, monkeypatch):
    session, project, _, graph = auto_flow
    original_text = test_graph_workflow.LocalProvider.text

    def no_recommendation(self, tool, context, instruction=""):
        result = original_text(self, tool, context, instruction)
        if tool == "propose_directions":
            for option in result["options"]:
                option.pop("recommended", None)
        return result

    monkeypatch.setattr(test_graph_workflow.LocalProvider, "text", no_recommendation)
    _, state = advance(session, project, graph)
    assert [item["recommended"] for item in state["directions"]] == [True, False, False]
    complete_jobs(session, project)
    _, state = advance(session, project, graph)
    assert state["chosen_direction_id"] == state["directions"][0]["id"]


def test_auto_selects_originals_and_skips_failed_verification(auto_flow):
    session, project, _, graph = auto_flow
    reach_images(session, project, graph)
    jobs = complete_jobs(session, project)
    originals = [job for job in jobs if not job.payload.get("purpose")]
    originals[1].result = {"edit_check": {"passed": False, "reason": "袖口未还原"}}
    source = originals[0]
    session.commit()
    # User chat/actions remain available in auto, and their jobs join current intents.
    edit = run_turn(graph, project, None, {
        "type": "edit_image", "image_id": source.id, "instruction": "背景暗一点",
    })
    alternate = session.get(Job, edit["jobs"][0]["id"])
    assert alternate.payload["version"] == 2
    current_intents = get_graph_state(graph, project.id)["job_intents"]
    assert alternate.id in {item["id"] for item in current_intents}
    complete_jobs(session, project)
    _, state = advance(session, project, graph)
    selected = state["note"]["image_ids"]
    assert set(selected) == {job.id for job in originals if job != originals[1]}
    assert source.id in selected and alternate.id not in selected
    assert state["note"]["accepted_unverified_ids"] == []


@pytest.mark.parametrize("failure", ["failed", "auto_fix_skipped", "fidelity_error", "retry_error"])
def test_task_failure_keeps_current_stage_and_announces_takeover(auto_flow, failure):
    session, project, _, graph = auto_flow
    reach_images(session, project, graph)
    job = session.scalar(select(Job).where(
        Job.project_id == project.id, Job.payload["purpose"].as_string().is_(None),
    ))
    reason = "衣服核对没有通过"
    if failure == "failed":
        job.status, job.error = "failed", reason
    else:
        job.result = {failure: reason}
    session.commit()
    changed, state = advance(session, project, graph)
    assert changed and project.mode == state["mode"] == "guided"
    assert project.stage == state["stage"] == "images"
    assert auto_info(project, state)["active"] is False
    message = automatic_messages(session, project)[-1]
    assert reason in message.text and "拍摄这组片" in message.text
    assert "已交回给你" in message.text and "调整脚本" in message.text
    assert advance(session, project, graph)[0] is False


def test_takeover_during_generation_keeps_jobs_and_next_confirmation(auto_flow):
    session, project, _, graph = auto_flow
    reach_images(session, project, graph)
    before = {job.id: job.status for job in session.scalars(select(Job))}
    take_over(session, project, graph)
    session.commit()
    assert project.mode == "guided"
    assert {job.id: job.status for job in session.scalars(select(Job))} == before
    assert advance(session, project, graph)[0] is False
    complete_jobs(session, project)
    assert advance(session, project, graph)[0] is False
    state = get_graph_state(graph, project.id)
    assert state["stage"] == "images" and state["note"] is None
    selected = [job.id for job in session.scalars(select(Job))
                if not job.payload.get("purpose")]
    turn = run_turn(graph, project, None, {"type": "approve_images", "image_ids": selected})
    assert turn["stage"] == "note" and turn["pending_action"]["type"] == "confirm_video"
    assert session.scalar(select(Job).where(Job.kind == "video")) is None


def test_takeover_at_script_restores_confirmation_without_spending(auto_flow):
    session, project, _, graph = auto_flow
    advance(session, project, graph)
    complete_jobs(session, project)
    advance(session, project, graph)
    take_over(session, project, graph)
    session.commit()
    state = get_graph_state(graph, project.id)
    assert state["stage"] == "script" and state["pending_action"]["type"] == "confirm_script"
    assert advance(session, project, graph)[0] is False
    assert all(job.payload.get("purpose") == "preview" for job in session.scalars(select(Job)))


def test_state_poll_after_video_success_leaves_final_transition_to_coordinator(
    auto_flow, monkeypatch,
):
    import app.main as main

    session, project, _, graph = auto_flow
    reach_images(session, project, graph)
    complete_jobs(session, project)
    assert advance(session, project, graph)[1]["stage"] == "note"
    assert advance(session, project, graph)[1]["stage"] == "video"
    complete_jobs(session, project)
    before = len(automatic_messages(session, project))
    monkeypatch.setattr(main, "project_lock", lambda *args, **kwargs: False)
    monkeypatch.setattr(main, "graph_for", lambda session, project: (
        graph, Workflow(session, project),
    ))
    polled = main.get_state(project.id, session.get(User, project.user_id), session)
    assert polled["stage"] == project.stage == "video"
    assert polled["auto"]["active"] is True and polled["auto"]["step"] == "video"
    factory = sessionmaker(session.get_bind(), expire_on_commit=False)
    assert tick_auto_projects(graph, factory) is True
    session.expire_all()
    state = get_graph_state(graph, project.id)
    assert state["stage"] == project.stage == "done"
    assert state["auto"]["step"] == "done" and auto_info(project, state)["active"] is False
    announcements = automatic_messages(session, project)
    assert len(announcements) == before + 1
    assert announcements[-1].text == "全套已出好。"


@pytest.mark.parametrize("failure", ["model", "budget"])
def test_tick_rolls_back_and_downgrades_model_or_budget_error(auto_flow, monkeypatch, failure):
    session, project, _, graph = auto_flow
    advance(session, project, graph)
    complete_jobs(session, project)
    advance(session, project, graph)
    if failure == "model":
        def failing_text(self, tool, context, instruction=""):
            raise RuntimeError("provider secret must never appear in a user message")

        monkeypatch.setattr(test_graph_workflow.LocalProvider, "text", failing_text)
    else:
        config = default_runtime_settings()
        config["tiers"]["free"]["daily_budget_cny"] = 0
        save_runtime_settings(session, config)
        session.commit()
    factory = sessionmaker(session.get_bind(), expire_on_commit=False)
    assert tick_auto_project(project.id, graph, factory) is True
    session.expire_all()
    state = get_graph_state(graph, project.id)
    assert project.mode == state["mode"] == "guided"
    assert project.stage == state["stage"] == "script"
    assert state["pending_action"]["type"] == "confirm_script"
    assert session.scalar(select(Job).where(Job.payload["purpose"].as_string().is_(None))) is None
    message = automatic_messages(session, project)[-1]
    assert "已交回给你" in message.text and "provider secret" not in message.text
    assert "模型" in message.text if failure == "model" else "预算" in message.text
    assert tick_auto_project(project.id, graph, factory) is False


@pytest.mark.parametrize("target", ["images", "video"])
def test_restart_recovers_checkpoint_jobs_after_business_rollback_without_duplicates(
    auto_flow, target,
):
    session, project, saver, graph = auto_flow
    advance(session, project, graph)
    complete_jobs(session, project)
    advance(session, project, graph)
    if target == "video":
        advance(session, project, graph)
        complete_jobs(session, project)
        advance(session, project, graph)
    prior_stage = project.stage
    assert advance_auto(session, project, graph, Workflow(session, project)) is True
    state = get_graph_state(graph, project.id)
    assert state["stage"] == target
    intended_ids = {item["id"] for item in state["job_intents"]}
    started = state["auto"]["started_at"]
    session.rollback()
    assert project.stage == prior_stage
    factory = sessionmaker(session.get_bind(), expire_on_commit=False)
    restarted = build_graph(saver)
    # The checkpoint already moved on, but its SQL jobs and messages rolled back.
    assert tick_auto_project(project.id, restarted, factory) is False
    session.expire_all()
    recovered = session.scalars(select(Job).where(Job.project_id == project.id)).all()
    assert {job.id for job in recovered} == intended_ids
    assert len({job.dedupe_key for job in recovered}) == len(recovered)
    assert get_graph_state(restarted, project.id)["auto"]["started_at"] == started
    assert tick_auto_project(project.id, restarted, factory) is False
    session.expire_all()
    assert {job.id for job in session.scalars(select(Job))} == intended_ids
    complete_jobs(session, project)
    assert tick_auto_project(project.id, restarted, factory) is True
    final = get_graph_state(restarted, project.id)
    assert final["stage"] == ("note" if target == "images" else "done")
    assert final["pending_action"] is None
    session.expire_all()
    assert session.get(Project, project.id).stage == final["stage"]


def test_chat_during_auto_does_not_expose_confirmation_or_duplicate_jobs(auto_flow):
    session, project, _, graph = auto_flow
    reach_images(session, project, graph)
    before = {job.id for job in session.scalars(select(Job))}
    reply = run_turn(graph, project, "你好，先聊聊", None)
    session.commit()
    state = get_graph_state(graph, project.id)
    assert reply["trace"]["tool"] == "chat"
    assert project.mode == "auto" and state["pending_action"] is None
    assert {job.id for job in session.scalars(select(Job))} == before
    assert advance(session, project, graph)[0] is False
