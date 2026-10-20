"""Durable PostgreSQL generation queue; run with ``python -m app.worker``."""

from __future__ import annotations

import hashlib
import logging
import signal
import threading
from datetime import timedelta

import httpx
from sqlalchemy import and_, or_, select, text, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.media import store_generated
from app.models import Asset, Job, Project, utcnow
from app.providers import ProviderError, ProviderHub

logger = logging.getLogger("outfit.worker")


def max_attempts() -> int:
    return int(settings.worker_max_attempts)


def lease_seconds() -> int:
    return int(settings.worker_lease_seconds)


def claim_job(session: Session) -> Job | None:
    """Claim one job in a short transaction, recovering an expired worker lease."""
    now = utcnow()
    stale = now - timedelta(seconds=lease_seconds())
    # A crashed synchronous request may have reached the paid provider. Without
    # an upstream task id, automatic re-submission could charge twice.
    session.execute(
        update(Job)
        .where(
            Job.status == "running",
            Job.locked_at < stale,
            Job.result["external_request_started"].as_boolean().is_(True),
            Job.payload["provider_task_id"].as_string().is_(None),
        )
        .values(status="failed", locked_at=None, error="上次生成结果未知，为避免重复计费已停止。")
    )
    # A worker may die on its final attempt. Surface that terminal failure rather
    # than leaving a running item permanently in the user's workbench.
    session.execute(
        update(Job)
        .where(
            Job.status == "running",
            Job.locked_at < stale,
            Job.attempts >= max_attempts(),
        )
        .values(status="failed", locked_at=None, error="任务执行中断，已达到重试上限。")
    )
    job = session.scalar(
        select(Job)
        .join(Project, Job.project_id == Project.id)
        .where(
            Project.deleted_at.is_(None),
            Job.attempts < max_attempts(),
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
        if asset is None or asset.user_id != job.user_id:
            raise ProviderError("任务引用的素材不存在或不属于当前账号。")
        if asset.project_id is not None and asset.project_id != job.project_id:
            raise ProviderError("任务引用了另一个项目的素材。")
        result.append(asset)
    return result


def process_job(job_id: str, attempt: int, session_factory=SessionLocal) -> None:
    """External generation runs outside the transaction used to claim the job.

    attempt is a fencing token: a superseded worker cannot overwrite a newer
    attempt's result. The heartbeat keeps healthy long generations from expiring.
    """
    with session_factory() as session:
        job = session.get(Job, job_id)
        if not job or job.status != "running" or job.attempts != attempt:
            return
        project = session.get(Project, job.project_id)
        if not project or project.deleted_at:
            job.status, job.locked_at, job.error = "failed", None, "项目已删除。"
            session.commit()
            return
        payload = dict(job.payload)
        project_id = job.project_id
        hub = ProviderHub(session, job.project_id)

        def on_submitted(task_id: str) -> None:
            # Persist before the first poll: process death and timeout retries
            # resume this exact upstream task without another paid submission.
            session.refresh(job)
            if job.attempts != attempt or job.status != "running":
                raise ProviderError("任务租约已失效。")
            job.payload = {**job.payload, "provider_task_id": task_id}
            job.result = {**job.result, "provider_task_id": task_id}
            session.commit()

        try:
            with LeaseHeartbeat(job_id, attempt, session_factory):
                if not settings.mock_providers:
                    job.result = {**job.result, "external_request_started": True}
                    session.commit()
                prompt = str(payload.get("prompt", payload.get("instruction", "")))
                if job.kind in {"image", "edit"}:
                    references = _assets(session, job, payload.get("reference_asset_ids", []))
                    media = hub.image(prompt, references)
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
                else:
                    raise ProviderError("不支持的生成任务类型。")
                # Release read snapshots before the brief final write lock.
                session.rollback()
                job = session.scalar(select(Job).where(Job.id == job_id).with_for_update())
                project = session.get(Project, job.project_id)
                if job.status != "running" or job.attempts != attempt:
                    session.rollback()
                    return
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
                )
                job.result_asset_id = asset.id
                job.result = {**job.result, "asset_id": asset.id}
                job.status, job.locked_at, job.error = "succeeded", None, None
                project.updated_at = utcnow()
                session.commit()
                logger.info("任务 %s 完成，尝试次数 %s", job_id, attempt)
        except Exception as exc:
            session.rollback()
            if session.get_bind().dialect.name == "postgresql":
                # Same lock and ordering as API deletion: the deleted flag and
                # retry decision must be observed in one serialized operation.
                lock_id = int.from_bytes(
                    hashlib.sha256(project_id.encode()).digest()[:8],
                    "big",
                    signed=True,
                )
                session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
            job = session.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if not job or job.status != "running" or job.attempts != attempt:
                return
            retryable = isinstance(exc, ProviderError) and exc.retryable
            # Transport failures after an image POST can be ambiguous; do not
            # blindly repeat paid synchronous generation. Video with a saved
            # task id is safe to resume even after poll transport failure.
            if isinstance(exc, httpx.HTTPError):
                retryable = job.kind == "video" and bool(job.payload.get("provider_task_id"))
            message = str(exc) if isinstance(exc, ProviderError) else "生成服务暂时不可用。"
            project = session.get(Project, job.project_id)
            if project is None or project.deleted_at:
                retryable, message = False, "项目已删除。"
            job.error = message[:500]
            job.locked_at = None
            if retryable and attempt < max_attempts():
                job.status = "queued"
                job.available_at = utcnow() + timedelta(seconds=min(2**attempt, 30))
            else:
                job.status = "failed"
            session.commit()
            logger.warning("任务 %s %s（尝试 %s）：%s", job_id, job.status, attempt, job.error)


def run_once(session_factory=SessionLocal) -> bool:
    with session_factory() as session:
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
    while not stopped.is_set():
        try:
            if not run_once():
                stopped.wait(settings.worker_poll_seconds)
        except Exception:
            logger.warning("队列暂时不可用，稍后重连")
            stopped.wait(max(settings.worker_poll_seconds, 2))


if __name__ == "__main__":
    main()
