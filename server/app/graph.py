"""Durable conversation graph: every external input resumes a checkpointed pause.

Waiting nodes contain no side effects before interrupt(): LangGraph re-executes that
node on resume. Generation itself remains in the separate database worker queue.
"""

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, TypedDict
from uuid import uuid4

from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, interrupt


class AgentState(TypedDict, total=False):
    stage: str
    brief: dict
    garments: list[dict]
    model_asset_id: str | None
    directions: list[dict]
    chosen_direction_id: str | None
    script: dict | None
    images: list[dict]
    note: dict | None
    video: dict | None
    pending_action: dict | None
    messages: Annotated[list, add_messages]
    incoming: dict
    job_intents: list[dict]
    turn_text: str
    turn_cards: list[dict]
    turn_jobs: list[dict]


def _history(event: dict, result: dict) -> list[dict]:
    turn_id = event["turn_id"]
    user_text = event.get("text") or json.dumps(event.get("action"), ensure_ascii=False)
    created_at = datetime.fromisoformat(event["created_at"])
    return [
        {
            "role": "user",
            "content": user_text,
            "id": f"{turn_id}:user",
            "additional_kwargs": {
                "display": {
                    "text": event.get("text") or "",
                    "cards": [],
                    "action": deepcopy(event.get("action")),
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
                    "created_at": (created_at + timedelta(microseconds=1)).isoformat(
                        timespec="microseconds"
                    ),
                }
            },
        },
    ]


def build_graph(checkpointer: Any, workflow: Any):
    """Build with PostgresSaver in production; tests may inject InMemorySaver.

    The graph is rebuilt per HTTP turn with a fresh transaction-bound Workflow.
    Its durable identity is the project ID, never a process-local Python object.
    """
    builder = StateGraph(AgentState)

    def initialize(state: AgentState) -> dict:
        result = workflow.start(state["incoming"])
        return {**result, "messages": _history(state["incoming"], result)}

    def execute(state: AgentState) -> dict:
        result = workflow.handle(state, state["incoming"])
        return {**result, "messages": _history(state["incoming"], result)}

    def wait_for_input(state: AgentState) -> dict:
        event = interrupt(state.get("pending_action") or {"type": "message"})
        return {"incoming": event}

    def route(state: AgentState) -> str:
        stage = state.get("stage", "direction")
        return f"await_{stage}" if stage != "brief" else "await_direction"

    builder.add_node("understand_brief", initialize)
    builder.add_node("execute_stage_tool", execute)
    builder.add_edge(START, "understand_brief")
    wait_nodes = [
        f"await_{stage}" for stage in ("direction", "script", "images", "note", "video", "done")
    ]
    for name in wait_nodes:
        builder.add_node(name, wait_for_input)
        builder.add_edge(name, "execute_stage_tool")
    builder.add_conditional_edges("understand_brief", route, wait_nodes)
    builder.add_conditional_edges("execute_stage_tool", route, wait_nodes)
    graph = builder.compile(checkpointer=checkpointer)
    # This is only the current request's dependency, never conversation state.
    graph._outfit_workflow = workflow
    return graph


def get_graph_state(graph: Any, project_id: str) -> dict:
    snapshot = graph.get_state({"configurable": {"thread_id": project_id}})
    return dict(snapshot.values or {})


def run_turn(graph: Any, project: Any, text: str | None, action: dict | None) -> dict:
    config = {"configurable": {"thread_id": project.id}}
    snapshot = graph.get_state(config)
    state = dict(snapshot.values or {})
    event = {
        "text": text or "",
        "action": action,
        "turn_id": str(uuid4()),
        "created_at": datetime.now(UTC).isoformat(timespec="microseconds"),
    }
    workflow = graph._outfit_workflow
    workflow.restore_jobs(state)
    # Reject malformed/out-of-stage actions before consuming the durable pause.
    workflow.validate(state, event)
    if not state.get("stage"):
        # START can already be checkpointed when the first provider call fails.
        # A fresh input restarts understand_brief instead of skipping it.
        graph.invoke({"incoming": event, "messages": []}, config)
    elif any(task.interrupts for task in snapshot.tasks):
        graph.invoke(Command(resume=event), config)
    else:
        # A provider exception may leave execute_stage_tool pending. Replace the
        # failed input so a corrected request can resume without a stuck thread.
        waiting_stage = state.get("stage", "direction")
        graph.update_state(config, {"incoming": event}, as_node=f"await_{waiting_stage}")
        graph.invoke(None, config)
    state = get_graph_state(graph, project.id)
    workflow.restore_jobs(state)
    return {
        "text": state.get("turn_text", ""),
        "cards": state.get("turn_cards", []),
        "jobs": state.get("turn_jobs", []),
        "stage": state.get("stage", "brief"),
        "pending_action": state.get("pending_action"),
    }
