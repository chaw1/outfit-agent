"""One durable automatic decision per tick, using the existing workflow actions.

Queue publication commits before this runner takes the conversation lock. Both
manual turns and takeover serialize with this lock; generation leases are intact.
"""

import hashlib
import logging

from sqlalchemy import select, text

from app.costs import auto_quote
from app.errors import AppError
from app.log_errors import log_exception
from app.models import Job, Project, utcnow
from app.views import restore_messages

log = logging.getLogger("outfit.auto")
LABELS = {
    "directions": "正在寻找拍摄方向", "script": "正在写拍摄脚本",
    "images": "正在拍摄这组片", "note": "正在写这组片的笔记",
    "video": "正在生成视频", "done": "全套已出好",
}
NEXT_ACTION = {
    "directions": "选择一个方向继续", "script": "查看并确认脚本",
    "images": "查看任务原因，调整脚本或选择已完成的图片",
    "note": "选择已完成的图片，继续写笔记", "video": "查看失败原因，先使用已完成的图文",
    "done": "查看已完成的内容",
}


def decision_lock(session, project_id: str, *, wait: bool = False) -> bool:
    if session.get_bind().dialect.name != "postgresql":
        return True
    # Same namespace as main.project_lock: auto is another project decision.
    key = int.from_bytes(hashlib.sha256(project_id.encode()).digest()[:8], "big", signed=True)
    function = "pg_advisory_xact_lock" if wait else "pg_try_advisory_xact_lock"
    acquired = session.scalar(text(f"SELECT {function}(:id)"), {"id": key})
    return True if wait else bool(acquired)


def auto_info(project, state: dict) -> dict | None:
    info = state.get("auto")
    if not info and project.mode != "auto":
        return None
    info = info or {
        "step": "directions", "started_at": project.created_at.isoformat(),
        "estimate_points": auto_quote()["estimate_points"],
    }
    step = "done" if state.get("stage") == "done" else info["step"]
    return {**info, "step": step, "label": LABELS[step],
            "active": project.mode == "auto" and step != "done"}


def _update(graph, project, values: dict) -> None:
    graph.update_state({"configurable": {"thread_id": project.id}}, values,
                       as_node="execute_stage_tool")


def _announcement(project, key: str, content: str) -> dict:
    return {
        "role": "assistant", "content": content, "id": f"{project.id}:auto:{key}",
        "additional_kwargs": {"display": {
            "text": content, "cards": [], "action": None, "refs": [],
            "can_regenerate": False, "created_at": utcnow().isoformat(),
            "trace": {"tool": "auto", "model": "workflow", "duration_ms": 0,
                      "cost_cny": 0, "cost_points": 0, "steps": []},
        }},
    }


def _step(graph, project, state: dict, step: str) -> None:
    info = {**auto_info(project, state), "step": step, "label": LABELS[step],
            "active": step != "done"}
    values = {"auto": info, "mode": project.mode,
              "style_tags": list(project.style_tags or []), "pending_action": None}
    if not state.get("auto") or state["auto"].get("step") != step:
        values["messages"] = [_announcement(project, f"step:{step}", LABELS[step] + "。")]
    _update(graph, project, values)


def take_over(session, project, graph, *, reason: str | None = None) -> None:
    from app.graph import get_graph_state
    from app.workflow import Workflow

    state = get_graph_state(graph, project.id)
    info = auto_info(project, state)
    project.mode = "guided"
    project.updated_at = utcnow()
    stage = state.get("stage", project.stage)
    pending_kind = {"direction": "choose_direction", "script": "confirm_script",
                    "note": "confirm_video"}.get(stage)
    values = {
        "mode": "guided", "auto": {**info, "active": False} if info else None,
        "pending_action": Workflow._pending(pending_kind) if pending_kind else None,
    }
    if reason and info:
        # Provider messages are deliberately sanitized, never raw exception text.
        label = LABELS[info["step"]]
        content = f"一键出片停在「{label}」：{reason}。已交回给你，请{NEXT_ACTION[info['step']]}。"
        values["messages"] = [_announcement(project, f"failed:{info['step']}", content)]
    if state or info:
        _update(graph, project, values)
        restore_messages(session, project.id, get_graph_state(graph, project.id))
    project.stage = stage


def _current_jobs(session, project, state: dict) -> list[Job]:
    # Intents identify this execution, including previews and user actions while
    # auto runs. Historical failures from an earlier script are not reselected.
    intents = state.get("job_intents", [])
    ids = {intent["id"] for intent in intents}
    jobs = list(session.scalars(select(Job).where(Job.project_id == project.id)))
    return [job for job in jobs if job.id in ids or job.payload.get("auto_fix_for") in ids]


def advance_auto(session, project, graph, workflow) -> bool:
    """Caller holds the decision lock and commits this one step or failure."""
    from app.graph import get_graph_state, run_turn
    from app.workflow import fingerprint

    if project.mode != "auto" or project.deleted_at:
        return False
    state = get_graph_state(graph, project.id)
    if state.get("stage"):
        project.stage = state["stage"]
    restore_messages(session, project.id, state)
    if state.get("stage") == "done":
        if (state.get("auto") or {}).get("step") != "done":
            _step(graph, project, state, "done")
            project.stage = "done"
            restore_messages(session, project.id, get_graph_state(graph, project.id))
            return True
        return False
    # Unlike read-time repair, automatic mode must not silently swallow a cap.
    for intent in state.get("job_intents", []):
        workflow._restore_job(intent)
    jobs = _current_jobs(session, project, state)
    failed = next((job for job in jobs if job.status == "failed"), None)
    skipped = next((job.result[key] for job in jobs
                    for key in ("auto_fix_skipped", "fidelity_error", "retry_error")
                    if job.result.get(key)), None)
    if failed or skipped:
        reason = (failed.error or "生成任务失败") if failed else skipped
        take_over(session, project, graph, reason=reason)
        return True
    stage = state.get("stage")
    if not stage or stage == "brief":
        # Save the initial step before calling a model, so failures can explain
        # where initialization stopped and retain a stable start time.
        _step(graph, project, state, "directions")
        run_turn(graph, project, "开始一键出片", None, workflow=workflow, automatic=True)
    elif stage == "direction":
        if any(job.status in {"queued", "running"} for job in jobs):
            return False
        directions = state.get("directions", [])
        if not directions:
            raise AppError("directions_missing", "暂时没有可用的拍摄方向")
        direction = next((item for item in directions if item.get("recommended")), directions[0])
        _step(graph, project, state, "script")
        run_turn(graph, project, None,
                 {"type": "choose_direction", "direction_id": direction["id"]},
                 workflow=workflow, automatic=True)
    elif stage == "script":
        _step(graph, project, state, "images")
        run_turn(graph, project, None, {"type": "confirm_script"},
                 workflow=workflow, automatic=True)
    elif stage == "images":
        if any(job.status in {"queued", "running"} for job in jobs):
            return False
        script_hash = fingerprint(state.get("script") or {})
        originals = {job.payload.get("shot_id"): job for job in jobs
                     if job.kind == "image" and job.payload.get("script_hash") == script_hash
                     and job.payload.get("version", 1) == 1
                     and job.status == "succeeded" and job.result_asset_id
                     and (job.result.get("edit_check") or {}).get("passed") is not False}
        # A person repair replaces a low-scoring original only when it passed.
        # Other manual edits and the garment selection rules stay unchanged.
        for shot_id, original in list(originals.items()):
            if (original.result.get("fidelity") or {}).get("person_score", 100) >= 70:
                continue
            repair = next((job for job in jobs
                           if job.payload.get("auto_fix_for") == original.id
                           and job.status == "succeeded" and job.result_asset_id
                           and (job.result.get("fidelity") or {}).get("person_score", 0) >= 70
                           and (job.result.get("edit_check") or {}).get("passed") is not False),
                          None)
            if repair is None:
                take_over(
                    session, project, graph,
                    reason="人像一致性重出后仍未达70分，请核对后手动选图",
                )
                return True
            originals[shot_id] = repair
        selected = [originals[shot["id"]].id for shot in state["script"]["shots"]
                    if shot["id"] in originals]
        if not selected:
            raise AppError("no_verified_images", "没有核对可用的原版图片，请检查后手动选图")
        _step(graph, project, state, "note")
        run_turn(graph, project, None, {"type": "approve_images", "image_ids": selected},
                 workflow=workflow, automatic=True)
    elif stage == "note":
        selected = state["note"]["image_ids"]
        if not selected:
            raise AppError("no_video_source", "笔记还没有可用的视频首帧")
        # The first v1 shot is the cover anchor and heads the selected shot order.
        _step(graph, project, state, "video")
        run_turn(graph, project, None, {"type": "confirm_video", "image_id": selected[0]},
                 workflow=workflow, automatic=True)
    elif stage == "video":
        video = session.get(Job, state["video"]["job_id"])
        if not video or video.status != "succeeded":
            return False
        _step(graph, project, state, "done")
        _update(graph, project, {"stage": "done", "video": workflow._video_card_content(video)})
        project.stage = "done"
    else:
        return False
    project.updated_at = utcnow()
    restore_messages(session, project.id, get_graph_state(graph, project.id))
    return True


def tick_auto_project(project_id, graph, session_factory) -> bool:
    from app.workflow import Workflow

    with session_factory() as session:
        if not decision_lock(session, project_id):
            return False
        project = session.get(Project, project_id, populate_existing=True)
        if not project or project.deleted_at or project.mode != "auto":
            return False
        try:
            changed = advance_auto(session, project, graph, Workflow(session, project))
            session.commit()
            return changed
        except Exception as exc:
            session.rollback()
            log_exception(log, "自动出片暂停", exc)
            decision_lock(session, project_id, wait=True)
            project = session.get(Project, project_id, populate_existing=True)
            if not project or project.deleted_at or project.mode != "auto":
                return False
            reason = getattr(exc, "message", "模型暂时未能完成，请稍后重试")
            take_over(session, project, graph, reason=reason)
            session.commit()
            return True


def tick_auto_projects(graph, session_factory) -> bool:
    from app.graph import get_graph_state

    with session_factory() as session:
        candidates = list(session.execute(select(Project.id, Project.stage).where(
            Project.mode == "auto", Project.deleted_at.is_(None),
        ).order_by(Project.updated_at)))
    changed = False
    for project_id, stage in candidates:
        # A normal chat can observe a completed video and project stage=done
        # before the automatic tail step is announced. SQL stage alone must not
        # hide that unfinished checkpoint; finalized projects need no turn/repair.
        if stage == "done" and (get_graph_state(graph, project_id).get("auto") or {}).get(
            "step"
        ) == "done":
            continue
        changed = tick_auto_project(project_id, graph, session_factory) or changed
    return changed
