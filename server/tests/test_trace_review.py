"""Independent checks that a text rewrite cannot replay paid workflow tools."""

from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app import main
from app.errors import AppError
from app.graph import build_graph, get_graph_state, run_turn
from app.models import Asset, Base, Job, Message, Project, User
from app.providers import ProviderHub
from app.workflow import Workflow


class ReviewProvider:
    def __init__(self, session, project_id):
        self.session = session
        self.calls = []

    def analyze_garments(self, assets):
        return [{"asset_id": asset.id, "category": "衬衫", "color": "白色",
                 "material": "棉", "style_tags": ["通勤"]} for asset in assets]

    def select_tool(self, tools, context, instruction=""):
        name, result = ProviderHub._mock_select_tool(tools, context, instruction)
        self.calls.append(name)
        if name == "write_script":
            context = {**context, "chosen_direction": context["directions"][0]}
        if name in {"propose_directions", "write_script", "revise_script"}:
            result = {**result, **ProviderHub._mock_text(name, context, instruction)}
        return name, result

    def text(self, tool, context, instruction=""):
        self.calls.append(tool)
        return ProviderHub._mock_text(tool, context, instruction)

    def regenerate_reply(self, previous, context):
        self.calls.append("regenerate_reply")
        return "换个说法：" + previous


@pytest.fixture
def review_flow(tmp_path, monkeypatch):
    monkeypatch.setattr("app.workflow.ProviderHub", ReviewProvider)
    engine = create_engine(f"sqlite:///{tmp_path / 'trace-review.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(username="trace-review", nickname="复核", password_hash="unused")
        session.add(user)
        session.flush()
        asset = Asset(user_id=user.id, kind="garment", path="unused.png", mime="image/png")
        session.add(asset)
        session.flush()
        project = Project(user_id=user.id, title="复核", brand="品牌", brief="通勤",
                          garment_asset_ids=[asset.id])
        session.add(project)
        session.commit()
        workflow = Workflow(session, project)
        graph = build_graph(InMemorySaver(), workflow)
        run_turn(graph, project, "想要通勤方向", None)
        main.restore_messages(session, project.id, get_graph_state(graph, project.id))
        session.commit()
        yield session, project, workflow, graph
    engine.dispose()


def assistant_id(state):
    return str(uuid5(NAMESPACE_URL, state["messages"][-1].id))


def test_paid_reply_rejected_before_any_rewrite_call(review_flow):
    session, project, workflow, graph = review_flow
    state = get_graph_state(graph, project.id)
    message_id = assistant_id(state)
    assert session.get(Message, message_id).can_regenerate is False
    before = list(workflow.providers.calls)
    with pytest.raises(AppError, match="付费生成任务") as rejected:
        main.regenerate_reply(session, graph, workflow, message_id)
    assert rejected.value.code == "cannot_regenerate"
    assert workflow.providers.calls == before


def test_rewrite_preserves_id_cards_domain_state_and_does_not_replay_tools(review_flow):
    session, project, workflow, graph = review_flow
    direction = get_graph_state(graph, project.id)["directions"][0]["id"]
    run_turn(graph, project, None, {"type": "choose_direction", "direction_id": direction})
    before = get_graph_state(graph, project.id)
    main.restore_messages(session, project.id, before)
    session.commit()
    message_id = assistant_id(before)
    message = session.get(Message, message_id)
    old_text, old_cards = message.text, deepcopy(message.cards)
    job_count = session.scalar(select(func.count()).select_from(Job))
    message_count = session.scalar(select(func.count()).select_from(Message))
    calls = list(workflow.providers.calls)
    assert message.can_regenerate is True
    events = main.regenerate_reply(session, graph, workflow, message_id)
    after = get_graph_state(graph, project.id)
    assert [entry.split("\n", 1)[0] for entry in events][-2:] == ["event: trace", "event: done"]
    assert message_id in events[-1]
    assert session.get(Message, message_id).text == "换个说法：" + old_text
    assert session.get(Message, message_id).cards == old_cards
    assert session.scalar(select(func.count()).select_from(Job)) == job_count
    assert session.scalar(select(func.count()).select_from(Message)) == message_count
    assert workflow.providers.calls == [*calls, "regenerate_reply"]
    for key in ("stage", "script", "directions", "pending_action", "job_intents"):
        assert after[key] == before[key]
    assert len(after["messages"]) == len(before["messages"])
    # A second rewrite still updates the same checkpoint message.
    main.regenerate_reply(session, graph, workflow, message_id)
    assert session.get(Message, message_id).text == "换个说法：换个说法：" + old_text
    assert session.scalar(select(func.count()).select_from(Job)) == job_count
    # Resuming after the rewritten checkpoint executes the new user instruction,
    # rather than replaying the preceding choose_direction action.
    result = run_turn(graph, project, "脚本调整得轻松一点", None)
    assert result["trace"]["tool"] == "revise_script"
    assert session.scalar(select(func.count()).select_from(Job)) == job_count


def test_rewrite_rejects_foreign_message_and_user_message(review_flow):
    session, project, workflow, graph = review_flow
    other = Project(user_id=project.user_id, title="其他项目", brand="品牌", brief="需求")
    session.add(other)
    session.flush()
    foreign = Message(project_id=other.id, role="assistant", text="其他回复", can_regenerate=True)
    session.add(foreign)
    session.flush()
    state = get_graph_state(graph, project.id)
    user_id = str(uuid5(NAMESPACE_URL, state["messages"][0].id))
    for message_id in (foreign.id, user_id, "does-not-exist"):
        with pytest.raises(AppError, match="不存在或不属于") as rejected:
            main.regenerate_reply(session, graph, workflow, message_id)
        assert rejected.value.status_code == 404
