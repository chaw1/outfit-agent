"""Local graph/queue tests: no services, paid models, or HTTP requests needed."""

from datetime import datetime, timedelta

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.graph import build_graph, get_graph_state, run_turn
from app.models import Asset, Base, Job, Project, User
from app.providers import ProviderHub
from app.workflow import Workflow


class LocalProvider:
    """Use the deterministic content fixture without accounting connections."""

    def __init__(self, session, project_id):
        self.calls = []

    def analyze_garments(self, assets):
        self.calls.append("analyze_garments")
        return [
            {
                "asset_id": item.id,
                "category": "衬衫",
                "color": "白色",
                "material": "待确认",
                "style_tags": ["简约"],
            }
            for item in assets
        ]

    def text(self, tool, context, instruction=""):
        self.calls.append(tool)
        return ProviderHub._mock_text(tool, context, instruction)


@pytest.fixture
def flow(monkeypatch):
    monkeypatch.setattr("app.workflow.ProviderHub", LocalProvider)
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(username="graph-test", password_hash="unused", nickname="测试")
        session.add(user)
        session.flush()
        assets = [
            Asset(user_id=user.id, kind=kind, path="fixture.png", mime="image/png", source="upload")
            for kind in ("garment", "garment", "model")
        ]
        session.add_all(assets)
        session.flush()
        project = Project(
            user_id=user.id,
            title="本地测试",
            brand="测试品牌",
            brief="夏季新品，想要松弛感",
            garment_asset_ids=[item.id for item in assets[:2]],
            model_asset_id=assets[2].id,
        )
        session.add(project)
        session.commit()
        saver = InMemorySaver()
        workflow = Workflow(session, project)
        graph = build_graph(saver, workflow)
        yield session, project, saver, graph
    engine.dispose()


def choose_script(graph, project):
    initial = run_turn(graph, project, "夏季新品，想要松弛感", None)
    assert {card["type"] for card in initial["cards"]} == {"garments", "directions"}
    assert initial["pending_action"]["type"] == "choose_direction"
    options = next(card for card in initial["cards"] if card["type"] == "directions")["options"]
    return run_turn(
        graph, project, None, {"type": "choose_direction", "direction_id": options[0]["id"]}
    )


def succeed_images(session, project):
    jobs = session.scalars(select(Job).where(Job.kind.in_(["image", "edit"]))).all()
    for job in jobs:
        if job.status == "succeeded":
            continue
        asset = Asset(
            user_id=project.user_id,
            project_id=project.id,
            kind="image",
            path="generated.png",
            mime="image/png",
            source="generated",
            parent_id=job.payload.get("parent_asset_id"),
        )
        session.add(asset)
        session.flush()
        job.status = "succeeded"
        job.result_asset_id = asset.id
    session.commit()
    return jobs


def test_restart_restores_script_pause_and_free_text_revision(flow):
    session, project, saver, graph = flow
    script_turn = choose_script(graph, project)
    assert script_turn["stage"] == "script"
    assert script_turn["pending_action"]["type"] == "confirm_script"
    assert script_turn["cards"][0]["status"] == "draft"
    assert len(script_turn["cards"][0]["shots"]) >= 4
    assert session.scalars(select(Job)).all() == []
    original = script_turn["cards"][0]["shots"][0]["scene"]
    session.commit()

    # New compiled graph + new Workflow represent a new API process/request.
    restarted = build_graph(saver, Workflow(session, project))
    changed = run_turn(restarted, project, "换成通勤风", None)
    assert changed["stage"] == "script"
    assert changed["pending_action"]["type"] == "confirm_script"
    assert changed["cards"][0]["shots"][0]["scene"] != original
    assert "写字楼" in changed["cards"][0]["shots"][0]["scene"]
    state = get_graph_state(restarted, project.id)
    assert len(state["messages"]) == 6
    assert state["chosen_direction_id"] == "direction-1"
    assert "测试品牌" in state["brief"]["summary"]
    assert "白色衬衫" in state["brief"]["summary"]
    assert "夏季新品" in state["brief"]["summary"]
    assert session.scalars(select(Job)).all() == []


def test_provider_context_has_only_limited_recent_conversation_text(flow):
    _, _, _, graph = flow
    messages = [{"role": "user", "content": f"earlier-{index}"} for index in range(14)]
    messages += [
        {"role": "assistant", "content": "好" * 2000},
        {"role": "tool", "content": "private tool output"},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "正文"}, {"type": "tool_call", "name": "private"}],
        },
    ]
    context = graph._outfit_workflow._context({"stage": "script", "messages": messages})
    recent = context["recent_messages"]
    assert len(recent) <= 12
    assert recent[0]["text"] == "earlier-5"
    assert len(recent[-2]["text"]) == 1000
    assert recent[-1] == {"role": "assistant", "text": "正文"}
    assert all(set(item) == {"role", "text"} for item in recent)
    assert "private" not in str(recent)


def test_checkpoint_messages_keep_recoverable_display_metadata(flow):
    session, project, saver, graph = flow
    script_turn = choose_script(graph, project)
    state = get_graph_state(graph, project.id)
    user, assistant = state["messages"][-2:]
    assert user.id.endswith(":user")
    assert assistant.id == user.id.removesuffix(":user") + ":assistant"
    user_display = user.additional_kwargs["display"]
    assistant_display = assistant.additional_kwargs["display"]
    assert user_display["cards"] == []
    assert user_display["action"] == {"type": "choose_direction", "direction_id": "direction-1"}
    assert assistant_display["cards"] == script_turn["cards"]
    assert assistant_display["action"] is None
    assert datetime.fromisoformat(assistant_display["created_at"]) - datetime.fromisoformat(
        user_display["created_at"]
    ) == timedelta(microseconds=1)
    assert datetime.fromisoformat(user_display["created_at"]).utcoffset() == timedelta(0)

    restarted = build_graph(saver, Workflow(session, project))
    changed = run_turn(restarted, project, "换成通勤风", None)
    history = get_graph_state(restarted, project.id)["messages"]
    assert history[-1].additional_kwargs["display"]["cards"] == changed["cards"]
    assert history[-3].additional_kwargs["display"]["cards"] == script_turn["cards"]
    assert history[-3].id == assistant.id


def test_first_provider_failure_can_restart_initialization(flow, monkeypatch):
    _, project, _, graph = flow
    provider = graph._outfit_workflow.providers
    original = provider.text

    def unavailable(*args, **kwargs):
        raise RuntimeError("temporary local provider failure")

    monkeypatch.setattr(provider, "text", unavailable)
    with pytest.raises(RuntimeError, match="temporary"):
        run_turn(graph, project, "先开始", None)
    state = get_graph_state(graph, project.id)
    assert not state.get("stage")
    monkeypatch.setattr(provider, "text", original)
    recovered = run_turn(graph, project, "重试，夏季新品", None)
    assert recovered["stage"] == "direction"
    assert recovered["pending_action"]["type"] == "choose_direction"
    assert len(get_graph_state(graph, project.id)["messages"]) == 2


def test_script_provider_failure_can_resume_with_corrected_input(flow, monkeypatch):
    _, project, _, graph = flow
    run_turn(graph, project, "开始", None)
    provider = graph._outfit_workflow.providers
    original = provider.text

    def unavailable(*args, **kwargs):
        raise RuntimeError("temporary local provider failure")

    monkeypatch.setattr(provider, "text", unavailable)
    with pytest.raises(RuntimeError, match="temporary"):
        run_turn(graph, project, None, {"type": "choose_direction", "direction_id": "direction-1"})
    monkeypatch.setattr(provider, "text", original)
    recovered = run_turn(
        graph, project, None, {"type": "choose_direction", "direction_id": "direction-2"}
    )
    assert recovered["stage"] == "script"
    assert "写字楼" in recovered["cards"][0]["shots"][0]["scene"]
    assert get_graph_state(graph, project.id)["chosen_direction_id"] == "direction-2"


def test_natural_image_edit_and_note_revision_stay_in_their_stage(flow, monkeypatch):
    session, project, _, graph = flow
    choose_script(graph, project)
    generated = run_turn(graph, project, None, {"type": "confirm_script"})
    ids = [job["id"] for job in generated["jobs"]]
    succeed_images(session, project)
    first_image = get_graph_state(graph, project.id)["images"][0]["id"]
    edited = run_turn(graph, project, "第一张背景太暗，调亮一点", None)
    edit_job = session.get(Job, edited["jobs"][0]["id"])
    assert edit_job.kind == "edit"
    assert edit_job.payload["version"] == 2
    assert edit_job.payload["parent_id"] == first_image

    run_turn(graph, project, None, {"type": "approve_images", "image_ids": ids[:2]})
    provider = graph._outfit_workflow.providers
    original = provider.text
    captured = []

    def revise(tool, context, instruction=""):
        captured.append((tool, context, instruction))
        return original(tool, context, instruction)

    monkeypatch.setattr(provider, "text", revise)
    revised = run_turn(graph, project, "标题改成轻松通勤日常", None)
    assert revised["cards"][0]["title"] == "轻松通勤日常"
    assert revised["cards"][0]["image_ids"] == ids[:2]
    assert revised["pending_action"]["type"] == "confirm_video"
    assert captured[-1][0] == "write_note"
    assert captured[-1][1]["selected_image_ids"] == ids[:2]
    assert len(session.scalars(select(Job).where(Job.kind == "video")).all()) == 0


@pytest.mark.parametrize(
    "action",
    [
        {"type": "confirm_script"},
        {"type": "edit_image", "image_id": "foreign"},
        {"type": "approve_images", "image_ids": ["foreign"]},
        {"type": "confirm_video", "image_id": "foreign"},
    ],
)
def test_forbidden_tools_do_not_create_jobs_or_consume_pause(flow, action):
    session, project, _, graph = flow
    run_turn(graph, project, "开始", None)
    with pytest.raises(AppError, match="当前阶段"):
        run_turn(graph, project, None, action)
    assert not session.scalars(select(Job)).all()
    snapshot = graph.get_state({"configurable": {"thread_id": project.id}})
    assert snapshot.next == ("await_direction",)
    assert any(task.interrupts for task in snapshot.tasks)
    assert run_turn(graph, project, "选第二个", None)["stage"] == "script"


def test_confirmations_queue_once_edit_has_parent_and_note_has_video_pause(flow):
    session, project, _, graph = flow
    choose_script(graph, project)
    images_turn = run_turn(graph, project, None, {"type": "confirm_script"})
    assert len(images_turn["jobs"]) == 4
    ids = [job["id"] for job in images_turn["jobs"]]
    repeated = run_turn(graph, project, None, {"type": "confirm_script"})
    assert [job["id"] for job in repeated["jobs"]] == ids
    assert len(session.scalars(select(Job)).all()) == 4
    succeed_images(session, project)

    edited = run_turn(
        graph,
        project,
        None,
        {"type": "edit_image", "image_id": ids[0], "instruction": "衬衫塞进裤腰"},
    )
    edit_id = edited["jobs"][0]["id"]
    edit_job = session.get(Job, edit_id)
    assert edit_job.payload["version"] == 2
    assert edit_job.payload["parent_id"] == ids[0]
    assert edit_job.payload["parent_asset_id"] == session.get(Job, ids[0]).result_asset_id
    run_turn(
        graph,
        project,
        None,
        {"type": "edit_image", "image_id": ids[0], "instruction": "衬衫塞进裤腰"},
    )
    assert len(session.scalars(select(Job)).all()) == 5
    succeed_images(session, project)

    note_turn = run_turn(
        graph, project, None, {"type": "approve_images", "image_ids": [edit_id, ids[1]]}
    )
    assert note_turn["stage"] == "note"
    assert note_turn["pending_action"]["type"] == "confirm_video"
    assert note_turn["cards"][0]["image_ids"] == [edit_id, ids[1]]
    assert not session.scalars(select(Job).where(Job.kind == "video")).all()
    video_turn = run_turn(graph, project, None, {"type": "confirm_video", "image_id": edit_id})
    assert video_turn["stage"] == "video"
    video_job = session.get(Job, video_turn["jobs"][0]["id"])
    assert video_job.payload["image_asset_id"] == edit_job.result_asset_id
    run_turn(graph, project, None, {"type": "confirm_video", "image_id": edit_id})
    assert len(session.scalars(select(Job).where(Job.kind == "video")).all()) == 1


def test_checkpoint_intents_repair_rolled_back_business_jobs(flow):
    session, project, _, graph = flow
    choose_script(graph, project)
    session.commit()
    generated = run_turn(graph, project, None, {"type": "confirm_script"})
    ids = [job["id"] for job in generated["jobs"]]
    session.rollback()
    assert not session.scalars(select(Job)).all()
    state = get_graph_state(graph, project.id)
    assert state["stage"] == "images"
    assert len(state["job_intents"]) == 4
    Workflow(session, project).restore_jobs(state)
    assert sorted(job.id for job in session.scalars(select(Job)).all()) == sorted(ids)


@pytest.mark.parametrize("target_stage", ["video", "done"])
def test_note_text_revision_preserves_existing_video_and_stage(flow, target_stage):
    session, project, _, graph = flow
    choose_script(graph, project)
    generated = run_turn(graph, project, None, {"type": "confirm_script"})
    image_ids = [job["id"] for job in generated["jobs"]][:2]
    succeed_images(session, project)
    original_note = run_turn(
        graph, project, None, {"type": "approve_images", "image_ids": image_ids}
    )
    video_turn = run_turn(graph, project, None, {"type": "confirm_video", "image_id": image_ids[0]})
    video_id = video_turn["jobs"][0]["id"]
    if target_stage == "done":
        asset = Asset(
            user_id=project.user_id,
            project_id=project.id,
            kind="reference",
            path="video.mp4",
            mime="video/mp4",
            source="generated",
        )
        session.add(asset)
        session.flush()
        job = session.get(Job, video_id)
        job.status, job.result_asset_id = "succeeded", asset.id
        session.commit()
        assert run_turn(graph, project, "视频好了吗", None)["stage"] == "done"
    before = get_graph_state(graph, project.id)
    jobs_before = [job.id for job in session.scalars(select(Job)).all()]

    revised = run_turn(graph, project, "标题改成：清爽通勤灵感", None)
    after = get_graph_state(graph, project.id)
    assert revised["cards"][0]["type"] == "note"
    assert revised["cards"][0]["title"] == "清爽通勤灵感"
    assert revised["cards"][0]["title"] != original_note["cards"][0]["title"]
    assert revised["cards"][0]["image_ids"] == image_ids
    assert revised["stage"] == target_stage
    assert revised["pending_action"] is None
    assert revised["jobs"] == []
    assert after["video"] == before["video"]
    assert after["video"]["job_id"] == video_id
    assert [job.id for job in session.scalars(select(Job)).all()] == jobs_before
    assert len(session.scalars(select(Job).where(Job.kind == "video")).all()) == 1


def test_foreign_image_cannot_be_edited_even_after_script_confirmation(flow):
    session, project, _, graph = flow
    choose_script(graph, project)
    run_turn(graph, project, None, {"type": "confirm_script"})
    user = User(username="another", password_hash="unused", nickname="其他人")
    session.add(user)
    session.flush()
    foreign_project = Project(
        user_id=user.id, title="其他项目", brand="另一品牌", brief="test", garment_asset_ids=[]
    )
    session.add(foreign_project)
    session.flush()
    job = Job(
        project_id=foreign_project.id,
        user_id=user.id,
        kind="image",
        status="succeeded",
        payload={"shot_id": "shot-1", "version": 1},
        result={},
        dedupe_key="foreign",
    )
    session.add(job)
    session.flush()
    with pytest.raises(AppError) as error:
        run_turn(
            graph,
            project,
            None,
            {"type": "edit_image", "image_id": job.id, "instruction": "换背景"},
        )
    assert error.value.code == "image_not_found"
    assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 0
