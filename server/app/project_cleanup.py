"""Project deletion and durable, transaction-safe generated media cleanup."""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import delete, event, select, text, update
from sqlalchemy.orm import Session

from app.config import settings
from app.models import AppSetting, Asset, Job, Message, Project, utcnow

logger = logging.getLogger("outfit.cleanup")
CLEANUP_PREFIX = "media_cleanup:"
_CREATED_FILES = "outfit_created_media"


def safe_media_path(relative: str) -> Path | None:
    root = settings.media_dir.resolve()
    if Path(relative).name != relative:
        logger.error("拒绝清理非平级媒体路径")
        return None
    candidate = root / relative
    resolved = candidate.resolve()
    if resolved == root or not resolved.is_relative_to(root):
        logger.error("拒绝清理媒体目录之外的文件")
        return None
    return candidate


def track_generated_file(session: Session, relative: str) -> None:
    """A database rollback or Session.close must not leak a newly written file."""
    path = safe_media_path(relative)
    if path is not None:
        session.info.setdefault(_CREATED_FILES, set()).add(path)


@event.listens_for(Session, "after_commit")
def _retain_committed_files(session: Session) -> None:
    session.info.pop(_CREATED_FILES, None)


@event.listens_for(Session, "after_transaction_end")
def _remove_uncommitted_files(session: Session, transaction) -> None:
    if transaction.parent is not None:
        return
    for path in session.info.pop(_CREATED_FILES, set()):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.exception("未提交媒体文件清理失败")


def drain_media_cleanup(session: Session, *, project_id: str | None = None) -> None:
    """Retry committed filesystem cleanup; failures retain the durable outbox row.

    Only committed outbox entries may be drained. Callers must commit their
    business transaction first. Worker polling provides restart recovery.
    """
    query = select(AppSetting).where(AppSetting.key.startswith(CLEANUP_PREFIX, autoescape=True))
    if project_id is not None:
        query = query.where(AppSetting.key == CLEANUP_PREFIX + project_id)
    entries = session.scalars(query.with_for_update(skip_locked=True)).all()
    for entry in entries:
        pending = []
        for relative in entry.value.get("paths", []):
            # An uploaded or retained asset can intentionally share a file.
            if session.scalar(select(Asset.id).where(Asset.path == relative).limit(1)):
                continue
            path = safe_media_path(relative)
            if path is None:
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pending.append(relative)
                logger.exception("项目媒体文件清理失败，将在下次 Worker 轮询重试")
        if pending:
            entry.value = {**entry.value, "paths": pending}
        else:
            session.delete(entry)
    session.commit()


def cleanup_project(session: Session, project: Project, *, commit: bool = True) -> None:
    """Delete project data atomically, then clean files after the commit.

    The API must check ownership and hold its conversation advisory lock first.
    A row lock shared with Worker publication fences every in-flight result.
    A project tombstone and its cost ledger intentionally remain for accounting.
    Account deletion passes commit=False to include every project in one transaction.
    """
    project = session.scalar(
        select(Project)
        .where(Project.id == project.id, Project.user_id == project.user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    project.deleted_at = project.deleted_at or utcnow()
    session.flush()
    generated = session.scalars(
        select(Asset).where(
            Asset.project_id == project.id,
            Asset.user_id == project.user_id,
            Asset.source == "generated",
            Asset.kind != "model",
        )
    ).all()
    asset_ids = [asset.id for asset in generated]
    paths = list(dict.fromkeys(asset.path for asset in generated))
    # Saved models are personal library copies, independent of the source project.
    # Detach their provenance when the source disappears so signed media stays usable.
    session.execute(update(Asset).where(
        Asset.project_id == project.id, Asset.user_id == project.user_id,
        Asset.kind == "model", Asset.source == "generated",
    ).values(project_id=None))
    session.execute(delete(Message).where(Message.project_id == project.id))
    session.execute(delete(Job).where(Job.project_id == project.id))
    if asset_ids:
        # Version chains may have a retained child: detach its deleted parent
        # before removing all generated versions in one statement.
        session.execute(update(Asset).where(Asset.parent_id.in_(asset_ids)).values(parent_id=None))
        session.execute(
            update(Project).where(Project.model_asset_id.in_(asset_ids)).values(model_asset_id=None)
        )
        session.execute(
            update(Job).where(Job.result_asset_id.in_(asset_ids)).values(result_asset_id=None)
        )
        session.execute(delete(Asset).where(Asset.id.in_(asset_ids)))
    if session.get_bind().dialect.name == "postgresql":
        # PostgresSaver uses this same database. Keep all three deletions inside
        # the business transaction instead of its independently committed API.
        for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
            session.execute(
                text(f"DELETE FROM {table} WHERE thread_id = :thread_id"),
                {
                    "thread_id": project.id,
                },
            )
    if paths:
        key = CLEANUP_PREFIX + project.id
        outbox = session.get(AppSetting, key)
        if outbox is None:
            session.add(AppSetting(key=key, value={"paths": paths}))
        else:
            outbox.value = {"paths": list(dict.fromkeys([*outbox.value.get("paths", []), *paths]))}
    if commit:
        session.commit()
        drain_media_cleanup(session, project_id=project.id)
    else:
        session.flush()
