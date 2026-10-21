"""Durable PostgreSQL generation queue; run with ``python -m app.worker``."""

from __future__ import annotations

import hashlib
import logging
import signal
import threading
import time
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

import httpx
from langgraph.checkpoint.postgres import PostgresSaver
from PIL import Image
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from sqlalchemy import and_, or_, select, text, update
from sqlalchemy.orm import Session, aliased

from app.auto_mode import tick_auto_projects
from app.config import settings
from app.costs import points
from app.db import SessionLocal
from app.edit_guidance import local_edit_prompt
from app.errors import AppError
from app.graph import build_graph
from app.local_edit import (
    compose_local_edit,
    crop_reference,
    prepare_selection,
    temporary_image_asset,
)
from app.log_errors import log_exception
from app.media import asset_path, store_generated
from app.model_library import is_preset_asset, model_references
from app.models import Asset, Job, Message, Model, Project, UsageLedger, utcnow
from app.project_cleanup import drain_media_cleanup
from app.providers import GeneratedMedia, ProviderError, ProviderHub
from app.runtime_settings import assert_generation_allowed, get_runtime_settings
from app.views import image_items

logger = logging.getLogger("outfit.worker")


def max_attempts() -> int:
    return int(settings.worker_max_attempts)


def lease_seconds() -> int:
    return int(settings.worker_lease_seconds)


def _anchor_ready():
    """A SQL predicate keeps waiting shots unclaimable across worker processes."""
    cover, repair = aliased(Job), aliased(Job)
    repairing = (
        select(repair.id)
        .where(
            repair.id == cover.result["auto_fix_job_id"].as_string(),
            repair.project_id == cover.project_id,
            repair.user_id == cover.user_id,
            repair.status.in_(["queued", "running"]),
        )
        .correlate(cover)
        .exists()
    )
    pending = (
        select(cover.id)
        .where(
            cover.id == Job.payload["anchor_job_id"].as_string(),
            cover.project_id == Job.project_id,
            cover.user_id == Job.user_id,
            or_(cover.status.in_(["queued", "running"]), repairing),
        )
        .correlate(Job)
        .exists()
    )
    return ~pending


def _attach_anchor(session: Session, job: Job) -> None:
    """Resolve the durable dependency once, retaining it unchanged on retries."""
    dependency = job.payload.get("anchor_job_id")
    if not dependency or job.payload.get("anchor_asset_id"):
        return
    cover = session.scalar(
        select(Job).where(Job.id == dependency).execution_options(populate_existing=True)
    )
    if (
        cover is None or cover.project_id != job.project_id or cover.user_id != job.user_id
        or cover.status != "succeeded" or not cover.result_asset_id
    ):
        # Only a terminal failure/missing cover reaches this branch. Transient
        # failures remain queued and are excluded by the claim predicate.
        return
    repair_id = cover.result.get("auto_fix_job_id")
    repaired = session.scalar(
        select(Job).where(Job.id == repair_id).execution_options(populate_existing=True)
    ) if repair_id else None
    if (
        repaired is not None and repaired.project_id == job.project_id
        and repaired.user_id == job.user_id and repaired.status == "succeeded"
        and repaired.result_asset_id
    ):
        cover = repaired
    job.payload = {
        **job.payload,
        "anchor_id": cover.payload.get("image_id", cover.id),
        "anchor_asset_id": cover.result_asset_id,
        "reference_asset_ids": list(dict.fromkeys([
            *job.payload.get("reference_asset_ids", []), cover.result_asset_id,
        ])),
        "prompt": str(job.payload.get("prompt", ""))
        + "以最后一张封面参考图为锚点，保持同一人、同一妆发与同一光线氛围；"
        + "服装仍严格遵循原衣服参考图。",
    }


def claim_job(session: Session) -> Job | None:
    """Claim one job in a short transaction, recovering an expired worker lease."""
    now = utcnow()
    stale = now - timedelta(seconds=lease_seconds())
    terminal = or_(
        and_(
            Job.result["external_request_started"].as_boolean().is_(True),
            Job.payload["provider_task_id"].as_string().is_(None),
        ),
        Job.attempts >= max_attempts(),
    )
    candidates = session.scalars(
        select(Job).where(
            Job.status == "running",
            Job.locked_at < stale,
            terminal,
        )
    ).all()
    # Use the same project-before-batch-before-job order as publication. Recheck
    # the lease after locking: an owner may have finished or renewed meanwhile.
    for candidate in sorted(candidates, key=lambda item: (item.project_id or "", _batch_key(item))):
        _completion_lock(session, candidate)
        expired = session.scalar(
            select(Job)
            .where(
                Job.id == candidate.id,
                Job.status == "running",
                Job.locked_at < stale,
                terminal,
            )
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if expired is None:
            continue
        unknown = expired.result.get("external_request_started") and not expired.payload.get(
            "provider_task_id",
        )
        expired.status, expired.locked_at = "failed", None
        expired.error = (
            "上次生成结果未知，为避免重复计费已停止。"
            if unknown
            else "任务执行中断，已达到重试上限。"
        )
        if expired.kind == "identity":
            model = session.get(Model, expired.payload.get("model_id"))
            if model and model.status != "deleted":
                model.status = "failed"
        else:
            _notify_completion(session, expired)
    job = session.scalar(
        select(Job)
        .outerjoin(Project, Job.project_id == Project.id)
        .where(
            or_(and_(Project.id.is_not(None), Project.deleted_at.is_(None)),
                and_(Job.kind == "identity", Job.project_id.is_(None))),
            Job.attempts < max_attempts(),
            _anchor_ready(),
            or_(
                and_(Job.status == "queued", Job.available_at <= now),
                and_(Job.status == "running", Job.locked_at < stale),
            ),
        )
        .order_by(Job.available_at, Job.created_at)
        .with_for_update(
            skip_locked=True,
            of=Job,
        )
        .limit(1)
    )
    if job is None:
        session.commit()
        return None
    _attach_anchor(session, job)
    job.status = "running"
    job.attempts += 1
    job.locked_at = now
    job.error = None
    session.commit()
    return job


class LeaseHeartbeat:
    def __init__(self, job_id: str, attempt: int, session_factory):
        self.job_id = job_id
        self.attempt = attempt
        self.session_factory = session_factory
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopped.set()
        self.thread.join(timeout=2)

    def _run(self):
        interval = max(1, lease_seconds() / 3)
        while not self.stopped.wait(interval):
            try:
                with self.session_factory() as session:
                    session.execute(
                        update(Job)
                        .where(
                            Job.id == self.job_id,
                            Job.status == "running",
                            Job.attempts == self.attempt,
                        )
                        .values(locked_at=utcnow())
                    )
                    session.commit()
            except Exception:
                logger.warning("任务 %s 续租失败，等待下一次续租", self.job_id)


def _assets(session: Session, job: Job, asset_ids: list[str]) -> list[Asset]:
    result = []
    for asset_id in dict.fromkeys(asset_ids):
        asset = session.get(Asset, asset_id)
        if asset is None or (asset.user_id != job.user_id and not (
            asset.user_id is None and is_preset_asset(session, asset.id)
        )):
            raise ProviderError("任务引用的素材不存在或不属于当前账号。")
        if (
            asset.project_id is not None and asset.project_id != job.project_id
            and not (asset.kind == "model" and asset.source == "generated")
        ):
            raise ProviderError("任务引用了另一个项目的素材。")
        result.append(asset)
    return result


def _batch_key(job: Job) -> str:
    if job.payload.get("completion_batch_key"):
        return job.payload["completion_batch_key"]
    if job.kind == "image":
        return job.payload.get("script_hash") or job.id
    return f"{job.kind}:{job.id}"


def _completion_lock(session: Session, job: Job) -> Project | Model | None:
    # Deletion, expired-lease reporting and publication share this row lock.
    # Lock the parent first: notification INSERTs also need its FK key-share
    # lock, so acquiring batch/job first can deadlock with concurrent deletion.
    if job.kind == "identity":
        return session.scalar(select(Model).where(
            Model.id == job.payload.get("model_id"),
        ).with_for_update())
    project = session.scalar(
        select(Project)
        .where(Project.id == job.project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    # A separate namespace keeps short publication transactions independent of
    # a conversation holding the project's decision lock during model calls.
    if session.get_bind().dialect.name == "postgresql":
        key = f"worker-completion:{job.project_id}:{_batch_key(job)}"
        lock_id = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big", signed=True)
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
    return project


def _lock_publication_job(session: Session, job_id: str) -> Job | None:
    snapshot = session.get(Job, job_id)
    if snapshot is None:
        return None
    if _completion_lock(session, snapshot) is None:
        return None
    # The batch lock can wait while another owner changes this row. Force a
    # fresh identity-map value after FOR UPDATE before checking the fencing token.
    return session.scalar(
        select(Job)
        .where(Job.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _auto_fix(session: Session, job: Job, asset: Asset) -> None:
    fidelity = job.result.get("fidelity")
    if (
        not fidelity
        or (fidelity["score"] >= 60 and fidelity.get("person_score", 100) >= 70)
        or job.payload.get("auto_fix")
        or job.kind == "edit"
    ):
        return
    key = f"{job.project_id}:auto-fix:{job.id}"
    fix_id = str(uuid5(NAMESPACE_URL, key))
    if session.get(Job, fix_id):
        return
    try:
        assert_generation_allowed(session, job.user_id)
    except AppError as exc:
        job.result = {**job.result, "auto_fix_skipped": exc.message}
        return
    garment_ids = list(dict.fromkeys(job.payload.get("garment_asset_ids", [])))
    project = session.get(Project, job.project_id)
    if not garment_ids:
        garment_ids = list(project.garment_asset_ids)
    diffs = "；".join(fidelity.get("diffs", [])) or "恢复原衣服的版型、颜色和细节"
    instruction = f"自动还原修复：{diffs}。严格保留原衣服版型、颜色、面料、纽扣、口袋和 logo。"
    person_refs, identity_text = model_references(session, project)
    low_person = fidelity.get("person_score", 100) < 70
    if low_person:
        instruction += (
            f"人像一致性仅 {fidelity['person_score']} 分，必须恢复身份卡中同一人的面部五官，"
            "保持肤色、发型发色与体态一致。"
        )
    descriptions = []
    for garment_id in garment_ids:
        garment = session.get(Asset, garment_id)
        analysis = garment.analysis if garment and garment.analysis else {}
        descriptions.append(
            "原衣服："
            + "".join(str(analysis.get(field, "")) for field in ("color", "material", "category"))
        )
    versions = session.scalars(select(Job).where(Job.project_id == job.project_id)).all()
    best = max(
        (item for item in versions if item.status == "succeeded" and item.result_asset_id
         and isinstance((item.result.get("fidelity") or {}).get("person_score"), (int, float))
         and item.payload.get("purpose") != "preview"
         and item.payload.get("model_asset_id", project.model_asset_id)
         == job.payload.get("model_asset_id", project.model_asset_id)),
        key=lambda item: (item.result["fidelity"]["person_score"], item.id), default=None,
    ) if low_person else None
    version = (
        max(
            (
                item.payload.get("version", 1)
                for item in versions
                if item.payload.get("shot_id") == job.payload.get("shot_id")
            ),
            default=job.payload.get("version", 1),
        )
        + 1
    )
    payload = {
        **job.payload,
        "image_id": fix_id,
        "version": version,
        "parent_id": job.payload.get("image_id", job.id),
        "parent_asset_id": asset.id,
        "source_asset_id": asset.id,
        "instruction": instruction,
        "prompt": (
            "参考图1为待修图，保留场景。"
            + (f"随后{len(person_refs)}张为人物身份卡，正脸优先，仅供身份参考。"
               if person_refs else "")
            + "接下来是原衣服图，只约束服装细节。"
            + ("另有上一版中人像分最高的成片，仅参考其面部身份。" if best else "")
            + (f"人物身份卡：{identity_text}。" if identity_text else "")
            + "；".join(descriptions)
            + "。"
            + instruction
            + ("最后一张是封面锚点，保留其人物身份、妆发与光线氛围。"
               if job.payload.get("anchor_asset_id") else "")
            + job.payload.get("reference_style_prompt", "")
        ),
        "reference_asset_ids": list(dict.fromkeys([
            asset.id, *person_refs,
            *(garment_ids if job.payload.get("anchor_asset_id") else garment_ids[:2]),
            *([best.result_asset_id] if best else []),
            *([job.payload["anchor_asset_id"]] if job.payload.get("anchor_asset_id") else []),
        ])),
        "garment_asset_ids": garment_ids,
        "best_person_asset_id": best.result_asset_id if best else None,
        "auto_fix_reason": "person" if low_person else "garment",
        "auto_fix": True,
        "auto_fix_for": job.id,
        "completion_batch_key": _batch_key(job),
    }
    # Upstream task handles never apply to the new, independent edit request.
    payload.pop("provider_task_id", None)
    fix = Job(
        id=fix_id,
        user_id=job.user_id,
        project_id=job.project_id,
        kind="edit",
        status="queued",
        payload=payload,
        result={},
        dedupe_key=key,
    )
    session.add(fix)
    job.result = {**job.result, "auto_fix_job_id": fix_id}
    session.flush()


def _score_summary(jobs: list[Job]) -> str:
    replaced = {
        item.payload.get("auto_fix_for")
        for item in jobs
        if item.payload.get("auto_fix") and item.status == "succeeded"
    }
    scores = [
        item.result["fidelity"]["score"]
        for item in jobs
        if item.id not in replaced and item.result.get("fidelity")
    ]
    summary = (
        f"还原分 {min(scores)}–{max(scores)}，平均 {sum(scores) / len(scores):.0f} 分。"
        if scores else "还原分暂未取得。"
    )
    for field, label in (("person_score", "人像一致性"), ("anchor_score", "封面一致性")):
        values = [
            item.result["fidelity"][field] for item in jobs
            if item.id not in replaced and item.status == "succeeded"
            and field in (item.result.get("fidelity") or {})
        ]
        if values:
            score = (
                str(min(values)) if min(values) == max(values) else f"{min(values)}–{max(values)}"
            )
            summary += f"{label} {score} 分。"
            if field == "person_score" and min(values) < 70:
                summary += "人像一致性仍低于70分，请核对后再选用。"
    return summary


def _edit_summary(jobs: list[Job]) -> str:
    unchecked = [
        item.result["edit_check"]
        for item in jobs
        if item.status == "succeeded"
        and item.result.get("edit_check")
        and not item.result["edit_check"]["passed"]
    ]
    if not unchecked:
        return ""
    reasons = "；".join(dict.fromkeys(item["reason"] for item in unchecked))
    return f"其中 {len(unchecked)} 张改图尚未确认按要求完成：{reasons}。原版仍保留着。"


def _worker_trace(session: Session, jobs: list[Job]) -> dict:
    """Use durable per-job accounting, including failed attempts and repairs.

    Project totals or before/after deltas would attribute a concurrent preview
    or conversation to this notification. Correlation in the reservation also
    survives a worker dying before it can publish its result.
    """
    rows = session.scalars(
        select(UsageLedger)
        .where(
            UsageLedger.project_id == jobs[0].project_id,
            UsageLedger.units["job_id"].as_string().in_([item.id for item in jobs]),
        )
        .order_by(UsageLedger.created_at, UsageLedger.id)
    ).all()
    video = jobs[0].kind == "video"
    editing = not video and all(item.kind == "edit" for item in jobs)
    kind = "video" if video else "image"
    tool = "generate_video" if video else "edit_image" if editing else "generate_images"
    originals = [item for item in jobs if not item.payload.get("auto_fix")]
    count = len(originals or jobs)
    label = f"生成视频 {count} 条" if video else f"{'改图' if editing else '出图'} {count} 张"
    models = list(dict.fromkeys(row.model for row in rows if row.kind == kind))
    if not models:
        for item in jobs:
            asset = session.get(Asset, item.result_asset_id) if item.result_asset_id else None
            model = asset.model if asset else item.payload.get("provider_model")
            if model and model not in models:
                models.append(model)
    if not models:
        models = [get_runtime_settings(session)["models"][kind]]
    repair_ids = {item.id for item in jobs if item.payload.get("auto_fix")}
    generation_ms = sum(
        row.duration_ms for row in rows
        if row.kind == kind and row.units.get("job_id") not in repair_ids
    )
    job_ms = sum(
        item.result.get("trace_duration_ms", item.result.get("duration_ms", 0)) for item in jobs
    )
    duration_ms = max(job_ms, sum(row.duration_ms for row in rows))
    steps = [{"label": label, "duration_ms": generation_ms if rows else duration_ms}]
    if repair_ids and originals:
        steps.append({
            "label": f"自动还原修复 {len(repair_ids)} 张",
            "duration_ms": sum(
                row.duration_ms for row in rows
                if row.kind == "image" and row.units.get("job_id") in repair_ids
            ),
        })
    elif repair_ids:
        steps[0]["duration_ms"] = sum(row.duration_ms for row in rows if row.kind == kind)
    for purpose, step_label in (("fidelity", "还原检查"), ("edit_check", "改图指令核对")):
        checks = [row for row in rows if row.units.get("purpose") == purpose]
        if checks:
            steps.append({
                "label": f"{step_label} {len(checks)} 次",
                "duration_ms": sum(row.duration_ms for row in checks),
            })
    other_checks = [
        row for row in rows
        if row.kind == "vision" and row.units.get("purpose") not in {"fidelity", "edit_check"}
    ]
    if other_checks:
        steps.append({
            "label": f"图片检查 {len(other_checks)} 次",
            "duration_ms": sum(row.duration_ms for row in other_checks),
        })
    refs = []
    for item in jobs:
        image_id = (
            item.payload.get("parent_id") or item.payload.get("image_id")
            if editing or video
            else item.payload.get("image_id", item.id)
        )
        if image_id and image_id not in refs:
            refs.append(image_id)
    return {
        "tool": tool,
        "model": " / ".join(models),
        "duration_ms": duration_ms,
        "cost_cny": float(sum((row.estimated_cny for row in rows), Decimal(0))),
        "cost_points": points(sum((row.estimated_cny for row in rows), Decimal(0))),
        "refs": refs,
        "steps": steps,
    }


def _publish(
    session: Session,
    job: Job,
    event: str,
    content: str,
    cards: list[dict],
    *,
    trace_jobs: list[Job] | None = None,
) -> None:
    message_id = str(uuid5(NAMESPACE_URL, f"{job.project_id}:worker:{event}"))
    if not session.get(Message, message_id):
        session.add(
            Message(
                id=message_id,
                project_id=job.project_id,
                role="assistant",
                text=content,
                cards=cards,
                trace=_worker_trace(session, trace_jobs or [job]),
                can_regenerate=False,
            )
        )


def _notify_completion(session: Session, job: Job) -> None:
    if job.payload.get("purpose") == "preview":
        return
    project = session.get(Project, job.project_id)
    if not project or project.deleted_at:
        return
    if job.kind == "video":
        if job.status in {"succeeded", "failed"}:
            source_id = job.payload.get("image_id")
            source = session.get(Job, source_id) if source_id else None
            summary = _score_summary([source] if source else [])
            source_id = job.payload.get("image_asset_id") or job.payload.get("source_asset_id")
            announcement = (
                "1 条 5 秒穿搭视频做好了！"
                if job.status == "succeeded"
                else f"1 条 5 秒视频未能完成：{job.error or '生成服务暂不可用'}。"
            )
            _publish(
                session,
                job,
                f"video:{job.id}",
                announcement + summary,
                [
                    {
                        "id": f"{job.project_id}:video",
                        "type": "video",
                        "status": job.status,
                        "job_id": job.id,
                        "poster_asset_id": source_id,
                    },
                ],
            )
        return
    session.flush()
    jobs = session.scalars(select(Job).where(Job.project_id == job.project_id)).all()
    batch = [
        item
        for item in jobs
        if item.kind in {"image", "edit"}
        and item.payload.get("purpose") != "preview"
        and _batch_key(item) == _batch_key(job)
    ]
    cards = [
        {
            "id": f"{job.project_id}:images",
            "type": "images",
            "items": image_items(session, job.project_id),
        }
    ]
    if job.payload.get("auto_fix") and job.status == "succeeded":
        _publish(
            session,
            job,
            f"auto-fix:{job.id}",
            ("1 张图的人像一致性自动修复做好了，原图和新版都保留着。"
             if job.payload.get("auto_fix_reason") == "person" else
             "1 张图的自动还原修复做好了，原图和新版都保留着。")
            + _score_summary([job]) + _edit_summary([job]),
            cards,
        )
    if not batch or any(item.status in {"queued", "running"} for item in batch):
        return
    originals = [item for item in batch if not item.payload.get("auto_fix")]
    succeeded = sum(item.status == "succeeded" for item in originals)
    repaired = sum(
        bool(item.payload.get("auto_fix")) and item.status == "succeeded" for item in batch
    )
    failed = sum(item.status == "failed" for item in batch)
    text_content = f"这批 {len(originals)} 张图都处理好了，成功 {succeeded} 张"
    if repaired:
        text_content += f"，另外自动补了 {repaired} 个修复版本"
    if failed:
        text_content += f"，有 {failed} 个任务失败，可在工作台查看原因"
    text_content += "。" + _score_summary(batch) + _edit_summary(batch)
    _publish(session, job, f"batch:{_batch_key(job)}", text_content, cards, trace_jobs=batch)


@dataclass
class ImageOutcome:
    media: GeneratedMedia
    fidelity: dict | None = None
    fidelity_error: str | None = None
    edit_check: dict | None = None
    region: dict | None = None
    retry_error: str | None = None


def _generate_image(
    session: Session, job: Job, project: Project, payload: dict, hub: ProviderHub
) -> ImageOutcome:
    """One edit has one shared retry budget for instruction and fidelity checks."""
    owner_attempt = job.attempts
    prompt = str(payload.get("prompt", payload.get("instruction", "")))
    references = _assets(session, job, payload.get("reference_asset_ids", []))
    originals = []
    identity = {}
    if payload.get("purpose") != "preview":
        originals = _assets(
            session, job, payload.get("garment_asset_ids", project.garment_asset_ids)
        )
        for field, asset_id in (
            ("model_asset", payload.get("model_asset_id", project.model_asset_id)),
            ("anchor_asset", payload.get("anchor_asset_id")),
        ):
            if asset_id:
                identity[field] = _assets(session, job, [asset_id])[0]
    before, selection = None, None
    if job.kind == "edit":
        source_id = payload.get("source_asset_id") or payload.get("parent_asset_id")
        if not source_id:
            raise ProviderError("改图任务没有来源图片。")
        before = _assets(session, job, [source_id])[0]
        if payload.get("region") is not None or payload.get("mask_strokes") is not None:
            with Image.open(asset_path(before)) as source:
                selection = prepare_selection(
                    source.size, payload.get("region"), payload.get("mask_strokes")
                )

    with ExitStack() as stack:
        if selection is not None:
            cropped = stack.enter_context(
                temporary_image_asset(crop_reference(before, selection), before)
            )
            # Wan takes its default output aspect from the last reference.
            anchor = identity.get("anchor_asset")
            face = identity.get("model_asset")
            references = ([face] if face else []) + (
                [*originals, anchor, cropped] if anchor else [*originals[:2], cropped]
            )
            prompt = local_edit_prompt(
                str(payload.get("instruction", "")), selection, anchor_reference=bool(anchor)
            )
            if face:
                prompt += "第一张为人物正脸身份参考，不是衣服图，也不是编辑画布。"
            if payload.get("identity_text"):
                prompt += f"人物身份卡：{payload['identity_text']}。"
            prompt += payload.get("reference_style_prompt", "")

        def render(current_prompt: str) -> GeneratedMedia:
            if job.kind == "edit":
                # Queue retries and quality corrections share the same two
                # submissions. Reserve under the row lock before any paid POST.
                session.refresh(job, with_for_update=True)
                if job.status != "running" or job.attempts != owner_attempt:
                    session.rollback()
                    raise ProviderError("任务租约已失效。")
                request_count = job.result.get("edit_image_request_count", 0)
                if request_count >= 2:
                    session.rollback()
                    raise ProviderError("改图已达到两次请求上限，为避免重复计费已停止。")
                job.result = {**job.result, "edit_image_request_count": request_count + 1}
                session.commit()
            media = hub.image(current_prompt, references)
            return compose_local_edit(before, media, selection) if selection else media

        def inspect(media: GeneratedMedia, *, repaired: bool = False) -> ImageOutcome:
            outcome = ImageOutcome(media=media, region=selection.region if selection else None)
            if payload.get("purpose") != "preview":
                try:
                    outcome.fidelity = {
                        **hub.fidelity(originals, media, **identity),
                        "auto_fixed": bool(payload.get("auto_fix")) or repaired,
                    }
                except Exception as exc:
                    outcome.fidelity_error = "还原分暂时无法取得，请稍后查看。"
                    log_exception(logger, f"任务 {job.id} 还原检查失败", exc)
            if before is not None:
                try:
                    with temporary_image_asset(media, before) as after:
                        outcome.edit_check = hub.check_edit(
                            before, after, str(payload.get("instruction", "")), outcome.region
                        )
                except Exception as exc:
                    outcome.edit_check = {
                        "passed": False,
                        "reason": "指令核对暂时无法完成，暂不能确认是否按要求改好。",
                    }
                    log_exception(logger, f"任务 {job.id} 指令核对失败", exc)
            return outcome

        outcome = inspect(render(prompt))
        check_failed = bool(outcome.edit_check and not outcome.edit_check["passed"])
        # An unavailable checker is not evidence that another paid edit helps.
        check_unavailable = bool(
            outcome.edit_check and "指令核对暂时无法完成" in outcome.edit_check["reason"]
        )
        low_fidelity = bool(outcome.fidelity and outcome.fidelity["score"] < 60)
        retry_allowed = (
            before is not None
            and not payload.get("auto_fix")
            and not job.result.get("edit_retry_count")
            and job.result.get("edit_image_request_count", 0) < 2
        )
        if retry_allowed and ((check_failed and not check_unavailable) or low_fidelity):
            details = []
            if check_failed and not check_unavailable:
                details.append("上次未落实修改：" + outcome.edit_check["reason"])
            if low_fidelity:
                details.append("恢复原衣服细节：" + "；".join(outcome.fidelity.get("diffs", [])))
            retry_prompt = (
                prompt + "。这是唯一一次纠正重试，必须实际改变用户指定的可见细节。"
                + "；".join(details)
                + "。用户原始指令必须落实：" + str(payload.get("instruction", ""))
            )
            # Persist the budget before submitting the second paid request. A
            # resumed worker can never silently acquire another correction.
            job.result = {**job.result, "edit_retry_count": 1}
            session.commit()
            try:
                outcome = inspect(render(retry_prompt), repaired=low_fidelity)
            except Exception as exc:
                outcome.retry_error = "自动重试未完成，已保留首次改图结果。"
                if outcome.edit_check:
                    outcome.edit_check = {
                        **outcome.edit_check,
                        "reason": outcome.edit_check["reason"] + "；" + outcome.retry_error,
                    }
                log_exception(logger, f"任务 {job.id} 改图重试失败，保留首次结果", exc)
        return outcome


def process_job(job_id: str, attempt: int, session_factory=SessionLocal) -> None:
    """External generation runs outside the transaction used to claim the job.

    attempt is a fencing token: a superseded worker cannot overwrite a newer
    attempt's result. The heartbeat keeps healthy long generations from expiring.
    """
    with session_factory() as session:
        job = session.get(Job, job_id)
        if job and job.kind == "identity":
            from app.identity_worker import process_identity
            session.close()
            process_identity(job_id, attempt, session_factory)
            return
        if not job or job.status != "running" or job.attempts != attempt:
            return
        started = time.monotonic()
        project = session.get(Project, job.project_id)
        if not project or project.deleted_at:
            session.rollback()
            return
        payload = dict(job.payload)
        hub = ProviderHub(session, job.project_id, trace_context={"job_id": job_id})

        def on_submitted(task_id: str) -> None:
            # Persist before the first poll: process death and timeout retries
            # resume this exact upstream task without another paid submission.
            session.refresh(job)
            if job.attempts != attempt or job.status != "running":
                raise ProviderError("任务租约已失效。")
            provider_model = hub._model("video")
            job.payload = {
                **job.payload, "provider_task_id": task_id, "provider_model": provider_model,
            }
            job.result = {
                **job.result, "provider_task_id": task_id, "provider_model": provider_model,
            }
            session.commit()

        try:
            with LeaseHeartbeat(job_id, attempt, session_factory):
                assert_generation_allowed(
                    session, job.user_id,
                    kinds=() if payload.get("provider_task_id") else (
                        ("video",) if job.kind == "video" else ("image",)
                    ),
                    # A saved upstream video task is already paid. Resume only
                    # its polling/download rather than stranding that result.
                    check_budget=not bool(payload.get("provider_task_id")),
                )
                if not settings.mock_providers:
                    job.result = {**job.result, "external_request_started": True}
                    session.commit()
                prompt = str(payload.get("prompt", payload.get("instruction", "")))
                outcome = None
                if job.kind in {"image", "edit"}:
                    outcome = _generate_image(session, job, project, payload, hub)
                    media = outcome.media
                elif job.kind == "video":
                    source_id = payload.get("image_asset_id") or payload.get("source_asset_id")
                    if not source_id:
                        raise ProviderError("视频任务没有来源图片。")
                    source = _assets(session, job, [source_id])[0]
                    media = hub.video(
                        prompt,
                        source,
                        provider_task_id=payload.get("provider_task_id"),
                        on_submitted=on_submitted,
                    )
                    if payload.get("provider_task_id") and payload.get("provider_model"):
                        media.model = payload["provider_model"]
                else:
                    raise ProviderError("不支持的生成任务类型。")
                # Release read snapshots before the brief final write lock.
                session.rollback()
                job = _lock_publication_job(session, job_id)
                if not job or job.status != "running" or job.attempts != attempt:
                    session.rollback()
                    return
                project = session.get(Project, job.project_id)
                if project.deleted_at:
                    raise ProviderError("项目已删除。")
                parent_id = payload.get("parent_asset_id") if job.kind == "edit" else None
                if parent_id:
                    _assets(session, job, [parent_id])
                asset = store_generated(
                    session,
                    user_id=job.user_id,
                    project_id=job.project_id,
                    kind="reference",
                    media=media,
                    parent_id=parent_id,
                    prompt=prompt,
                    preserve_visible_label=bool(outcome and outcome.region is not None),
                )
                job.result_asset_id = asset.id
                job.result = {
                    **job.result, "asset_id": asset.id,
                    "duration_ms": round((time.monotonic() - started) * 1000),
                    "trace_duration_ms": job.result.get("trace_duration_ms", 0)
                    + round((time.monotonic() - started) * 1000),
                }
                if outcome:
                    for key in (
                        "fidelity", "fidelity_error", "edit_check", "region", "retry_error"
                    ):
                        value = getattr(outcome, key)
                        if value is not None:
                            job.result = {**job.result, key: value}
                job.status, job.locked_at, job.error = "succeeded", None, None
                if job.kind in {"image", "edit"} and payload.get("purpose") != "preview":
                    _auto_fix(session, job, asset)
                _notify_completion(session, job)
                session.commit()
                logger.info("任务 %s 完成，尝试次数 %s", job_id, attempt)
        except Exception as exc:
            log_exception(logger, f"任务 {job_id} 生成失败", exc)
            session.rollback()
            # A concurrently deleted project is excluded by claim_job even if
            # deletion commits immediately after this retry decision. Avoid the
            # conversation lock here so failure reporting cannot wait on text.
            job = _lock_publication_job(session, job_id)
            if not job or job.status != "running" or job.attempts != attempt:
                return
            retryable = isinstance(exc, ProviderError) and exc.retryable
            if job.kind == "edit" and job.result.get("edit_image_request_count", 0) >= 2:
                retryable = False
            # Transport failures after an image POST can be ambiguous; do not
            # blindly repeat paid synchronous generation. Video with a saved
            # task id is safe to resume even after poll transport failure.
            if isinstance(exc, httpx.HTTPError):
                retryable = job.kind == "video" and bool(job.payload.get("provider_task_id"))
            message = (
                str(exc) if isinstance(exc, (ProviderError, AppError)) else "生成服务暂时不可用。"
            )
            project = session.get(Project, job.project_id)
            if project is None or project.deleted_at:
                retryable, message = False, "项目已删除。"
            job.error = message[:500]
            job.result = {
                **job.result, "duration_ms": round((time.monotonic() - started) * 1000),
                "trace_duration_ms": job.result.get("trace_duration_ms", 0)
                + round((time.monotonic() - started) * 1000),
            }
            job.locked_at = None
            if retryable and attempt < max_attempts():
                job.status = "queued"
                job.available_at = utcnow() + timedelta(seconds=min(2**attempt, 30))
            else:
                job.status = "failed"
                _notify_completion(session, job)
            session.commit()
            logger.warning("任务 %s %s（尝试 %s）：%s", job_id, job.status, attempt, job.error)


def run_once(session_factory=SessionLocal) -> bool:
    with session_factory() as session:
        drain_media_cleanup(session)
        job = claim_job(session)
        if job is None:
            return False
        job_id, attempt = job.id, job.attempts
    process_job(job_id, attempt, session_factory)
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    logger.info("生成 Worker 启动，mock=%s", settings.mock_providers)
    with ConnectionPool(
        settings.checkpoint_url, min_size=1, max_size=4,
        kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": 0},
    ) as pool:
        pool.wait(timeout=30)
        saver = PostgresSaver(pool)
        saver.setup()
        graph = build_graph(saver)
        while not stopped.is_set():
            try:
                worked = run_once()
                advanced = tick_auto_projects(graph, SessionLocal)
                if not worked and not advanced:
                    stopped.wait(settings.worker_poll_seconds)
            except Exception as exc:
                log_exception(logger, "队列暂时不可用，稍后重连", exc)
                stopped.wait(max(settings.worker_poll_seconds, 2))


if __name__ == "__main__":
    main()
