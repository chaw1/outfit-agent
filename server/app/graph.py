"""Durable decision graph; request dependencies arrive through Runtime context.

Waiting nodes have no side effects before interrupt. Worker jobs remain database
facts and are refreshed at turn entry; workers never race users to resume a pause.
The turn_* and incoming fields are output channels, not project domain state.
"""

import json
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, TypedDict
from uuid import uuid4

from langgraph.config import get_stream_writer
from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.runtime import Runtime
from langgraph.types import Command, interrupt

from app.workflow import fingerprint


class AgentState(TypedDict, total=False):
    stage: str
    mode: str
    style_tags: list[str]
    auto: dict | None
    brief: dict
    garments: list[dict]
    references: list[dict]
    model_asset_id: str | None
    directions: list[dict]
    chosen_direction_id: str | None
    chosen_preview_id: str | None
    script: dict | None
    script_revision: int
    images: list[dict]
    note: dict | None
    video: dict | None
    # 第几次制作短片；再做一条时递增，用它区分“新制作”和“同一次确认的重发”。
    video_attempt: int
    pending_action: dict | None
    messages: Annotated[list, add_messages]
    incoming: dict
    job_intents: list[dict]
    turn_text: str
    turn_cards: list[dict]
    turn_jobs: list[dict]
    turn_trace: dict
    turn_can_regenerate: bool


@dataclass(frozen=True)
class GraphContext:
    workflow: Any


@dataclass
class BoundGraph:
    """Test convenience only: production compiles once and passes GraphContext."""

    graph: Any
    workflow: Any

    def __getattr__(self, name: str):
        return getattr(self.graph, name)


def _history(event: dict, result: dict) -> list[dict]:
    turn_id = event["turn_id"]
    user_text = event.get("text") or json.dumps(event.get("action"), ensure_ascii=False)
    created_at = datetime.fromisoformat(event["created_at"])
    messages = [
        {
            "role": "user",
            "content": user_text,
            "id": f"{turn_id}:user",
            "additional_kwargs": {
                "display": {
                    "text": event.get("text") or "",
                    "cards": [],
                    "action": deepcopy(event.get("action")),
                    "refs": deepcopy(event.get("refs", [])),
                    "created_at": created_at.isoformat(timespec="microseconds"),
                }
            },
        },
        {
            "role": "assistant",
            "content": result.get("turn_text", ""),
            "id": f"{turn_id}:assistant",
            "additional_kwargs": {
                "display": {
                    "text": result.get("turn_text") or "",
                    "cards": deepcopy(result.get("turn_cards", [])),
                    "action": None,
                    "refs": [],
                    "trace": deepcopy(result.get("turn_trace")),
                    "can_regenerate": result.get("turn_can_regenerate", False),
                    "created_at": (created_at + timedelta(microseconds=1)).isoformat(
                        timespec="microseconds"
                    ),
                }
            },
        },
    ]
    return messages[1:] if event.get("automatic") else messages


def build_graph(checkpointer: Any, workflow: Any = None):
    """Compile once with PostgresSaver; transactions are supplied per invocation."""
    builder = StateGraph(AgentState, context_schema=GraphContext)

    def initialize(state: AgentState, runtime: Runtime[GraphContext]) -> dict:
        result = runtime.context.workflow.start(state["incoming"], emit=get_stream_writer())
        return {**result, "messages": _history(state["incoming"], result)}

    def execute(state: AgentState, runtime: Runtime[GraphContext]) -> dict:
        result = runtime.context.workflow.handle(state, state["incoming"])
        return {**result, "messages": _history(state["incoming"], result)}

    def wait_for_input(state: AgentState) -> dict:
        event = interrupt(state.get("pending_action") or {"type": "message"})
        return {"incoming": event}

    def route(state: AgentState) -> str:
        return f"await_{state.get('stage', 'brief')}"

    builder.add_node("understand_brief", initialize)
    builder.add_node("execute_stage_tool", execute)
    builder.add_edge(START, "understand_brief")
    wait_nodes = [
        f"await_{stage}"
        for stage in ("brief", "direction", "script", "images", "note", "video", "done")
    ]
    for name in wait_nodes:
        builder.add_node(name, wait_for_input)
        builder.add_edge(name, "execute_stage_tool")
    builder.add_conditional_edges("understand_brief", route, wait_nodes)
    builder.add_conditional_edges("execute_stage_tool", route, wait_nodes)
    graph = builder.compile(checkpointer=checkpointer)
    return BoundGraph(graph, workflow) if workflow is not None else graph


def get_graph_state(graph: Any, project_id: str) -> dict:
    snapshot = graph.get_state({"configurable": {"thread_id": project_id}})
    return dict(snapshot.values or {})


def _script_identity(script: dict) -> str:
    content = {key: value for key, value in script.items() if key != "status"}
    if content:
        content.setdefault("version", 1)
    return fingerprint(content)


def script_versions(graph: Any, project_id: str) -> list[dict]:
    """Project script versions derived exclusively from its checkpoint history."""
    current = get_graph_state(graph, project_id).get("script") or {}
    current_key = _script_identity(current)
    versions = {}
    for snapshot in graph.get_state_history({"configurable": {"thread_id": project_id}}):
        script = snapshot.values.get("script") or {}
        checkpoint_id = snapshot.config.get("configurable", {}).get("checkpoint_id")
        if not script or not checkpoint_id:
            continue
        key = _script_identity(script)
        # Iteration is newest-first: retain the original creation checkpoint for
        # each content version, rather than treating confirmation as a revision.
        versions[key] = {
            "version": script.get("version", 1),
            "checkpoint_id": checkpoint_id,
            "created_at": snapshot.created_at,
            "summary": " / ".join(script.get("title_ideas", [])[:2])
            or script.get("cover", {}).get("scene", "脚本"),
            "current": key == current_key,
        }
    return sorted(versions.values(), key=lambda item: (item["version"], item["created_at"] or ""))


def _load_script_history(graph: Any, project_id: str, workflow: Any) -> None:
    workflow.script_versions = script_versions(graph, project_id)
    allowed = {item["checkpoint_id"] for item in workflow.script_versions}
    workflow.restore_scripts = {}
    for checkpoint_id in allowed:
        snapshot = graph.get_state(
            {
                "configurable": {
                    "thread_id": project_id,
                    "checkpoint_id": checkpoint_id,
                }
            }
        )
        if snapshot.values.get("script"):
            restored = deepcopy(snapshot.values["script"])
            restored.setdefault("version", 1)
            workflow.restore_scripts[checkpoint_id] = restored


def run_turn(
    graph: Any,
    project: Any,
    text: str | None,
    action: dict | None,
    *,
    workflow: Any = None,
    emit: Callable[[str, dict], None] | None = None,
    refs: list[str] | None = None,
    automatic: bool = False,
) -> dict:
    workflow = workflow or getattr(graph, "workflow", None)
    if workflow is None:
        raise ValueError("run_turn requires a transaction-bound workflow")
    config = {"configurable": {"thread_id": project.id}}
    snapshot = graph.get_state(config)
    state = dict(snapshot.values or {})
    event = {
        "text": text or "",
        "action": action,
        "refs": list(refs or []),
        "turn_id": str(uuid4()),
        "created_at": datetime.now(UTC).isoformat(timespec="microseconds"),
        "automatic": automatic,
    }
    _load_script_history(graph, project.id, workflow)
    workflow.restore_jobs(state)
    workflow.validate(state, event)
    workflow.begin_turn(event)
    if not state.get("stage"):
        graph_input = {"incoming": event, "messages": []}
    elif any(task.interrupts for task in snapshot.tasks):
        graph_input = Command(resume=event)
    else:
        # A failed node can be resumed with corrected input without replaying the
        # old failed user request or consuming the durable pause twice.
        waiting_stage = state.get("stage", "brief")
        graph.update_state(config, {"incoming": event}, as_node=f"await_{waiting_stage}")
        graph_input = None
    for mode, value in graph.stream(
        graph_input,
        config,
        context=GraphContext(workflow=workflow),
        stream_mode=["custom", "updates"],
    ):
        if mode == "custom" and emit:
            emit(value["event"], value["data"])
    state = get_graph_state(graph, project.id)
    workflow.restore_jobs(state)
    return {
        "text": state.get("turn_text", ""),
        "cards": state.get("turn_cards", []),
        "jobs": state.get("turn_jobs", []),
        "stage": state.get("stage", "brief"),
        "pending_action": state.get("pending_action"),
        "trace": state.get("turn_trace"),
        "can_regenerate": state.get("turn_can_regenerate", False),
    }
