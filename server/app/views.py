import hashlib
import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from app.costs import AUTO_FIX_ALLOWANCE, image_cost_cny, video_cost_cny, with_points
from app.media import signed_url
from app.models import Asset, Job, Message, Project, UsageLedger, User
from app.runtime_settings import user_budget
from app.schemas import Profile


def user_dict(user: User, session: Session | None = None) -> dict:
    session = session if session is not None else object_session(user)
    budget = user_budget(user, session)
    return with_points({
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "created_at": user.created_at.isoformat(),
        "tier": budget["tier"],
        "daily_budget_cny": budget["daily_budget_cny"],
        "today_cost_cny": budget["today_cost_cny"],
        "profile": Profile.model_validate(user.profile or {}).model_dump(exclude_none=True),
    })


def pending_action_dict(state: dict) -> dict | None:
    """Project a current quote without changing the durable graph checkpoint."""
    pending = state.get("pending_action")
    if not pending:
        return None
    result = dict(pending)
    if pending["type"] == "confirm_script":
        shots = (state.get("script") or {}).get("shots", [])
        result["estimated_cost_cny"] = float(image_cost_cny(len(shots)) * AUTO_FIX_ALLOWANCE)
    elif pending["type"] == "confirm_video":
        result["estimated_cost_cny"] = float(video_cost_cny())
    return with_points(result)


def project_dict(project: Project, session: Session) -> dict:
    covers = session.scalars(
        select(Job)
        .where(
            Job.project_id == project.id, Job.status == "succeeded", Job.kind.in_(["image", "edit"])
        )
        .order_by(Job.created_at)
    ).all()
    cover = next((job for job in covers if job.payload.get("purpose") != "preview"), None)
    return {
        "id": project.id,
        "title": project.title,
        "brand": project.brand,
        "brief": project.brief,
        "stage": project.stage,
        "reference_asset_ids": list(project.reference_asset_ids or []),
        "cover_url": signed_url(cover.result_asset_id) if cover and cover.result_asset_id else None,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
    }


def job_dict(job: Job, session: Session | None = None) -> dict:
    return {
        "id": job.id,
        "project_id": job.project_id,
        "kind": job.kind,
        "status": job.status,
        "result_asset_id": job.result_asset_id,
        "url": signed_url(job.result_asset_id) if job.result_asset_id else None,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


def image_items(session: Session, project_id: str) -> list[dict]:
    jobs = session.scalars(
        select(Job)
        .where(Job.project_id == project_id, Job.kind.in_(["image", "edit"]))
        .order_by(Job.created_at, Job.id)
    ).all()
    return [
        {
            "id": job.payload.get("image_id", job.id),
            "shot_id": job.payload.get("shot_id", ""),
            "status": job.status,
            "url": signed_url(job.result_asset_id) if job.result_asset_id else None,
            "version": job.payload.get("version", 1),
            "parent_id": job.payload.get("parent_id"),
            "instruction": job.payload.get("instruction"),
            "error": job.error,
            "fidelity": job.result.get("fidelity"),
            "region": job.result.get("region", job.payload.get("region")),
            "edit_check": job.result.get("edit_check"),
            "script_version": job.payload.get("script_version"),
            **({"anchor_id": job.payload["anchor_id"]} if job.payload.get("anchor_id") else {}),
        }
        for job in jobs
        if job.payload.get("purpose") != "preview"
    ]


def direction_items(session: Session, project_id: str, directions: list[dict]) -> list[dict]:
    jobs = session.scalars(
        select(Job)
        .where(Job.project_id == project_id, Job.kind == "image")
        .order_by(Job.created_at, Job.id)
    ).all()
    previews = [job for job in jobs if job.payload.get("purpose") == "preview"]
    projected = []
    for original in directions:
        direction = dict(original)
        content = {
            key: value
            for key, value in original.items()
            if key not in {"preview_url", "preview_status"}
        }
        digest = hashlib.sha256(
            json.dumps(
                content,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        expected_key = f"{project_id}:preview:{digest}"
        exact = [job for job in previews if job.dedupe_key == expected_key]
        # Compatibility for old imported preview jobs without a content key.
        legacy = [
            job
            for job in previews
            if job.payload.get("direction_id") == direction.get("id")
            and not job.dedupe_key.startswith(f"{project_id}:preview:")
        ]
        job = (exact or legacy or [None])[-1]
        if job:
            direction.update(
                preview_status=job.status,
                preview_url=signed_url(job.result_asset_id) if job.result_asset_id else None,
            )
        projected.append(direction)
    return projected


def project_cost_cny(session: Session, project_id: str) -> float:
    # Failed and reserved requests retain their conservative estimate: a timeout
    # does not prove the provider did not charge for the accepted request.
    total = session.scalar(
        select(func.coalesce(func.sum(UsageLedger.estimated_cny), 0)).where(
            UsageLedger.project_id == project_id
        )
    )
    return round(float(total), 6)


def refresh_cards(cards: list, session: Session, project_id: str) -> list:
    # Stored cards keep stable IDs and content; short-lived URLs are minted at read time.
    refreshed = []
    for original in cards:
        card = dict(original)
        if card.get("type") in {"garments", "references"}:
            card["items"] = [
                dict(item, url=signed_url(item["asset_id"])) for item in card.get("items", [])
            ]
        elif card.get("type") == "images":
            card["items"] = image_items(session, project_id)
        elif card.get("type") == "directions":
            card["options"] = direction_items(session, project_id, card.get("options", []))
            # A fresh group may contain two or three previews; quote the upper count.
            card["regenerate_estimate_cny"] = float(image_cost_cny(3))
        elif card.get("type") == "note":
            card["cost_cny"] = project_cost_cny(session, project_id)
            card["ai_label"] = "内容含 AI 生成图片，发布时请勾选平台的 AI 内容声明。"
        elif card.get("type") == "video":
            job = session.get(Job, card.get("job_id")) if card.get("job_id") else None
            if job:
                card.update(
                    status=job.status,
                    url=signed_url(job.result_asset_id) if job.result_asset_id else None,
                )
                source = job.payload.get("image_asset_id")
                if source and session.get(Asset, source):
                    card["poster_url"] = signed_url(source)
        refreshed.append(with_points(card))
    return refreshed


def message_dict(message: Message, session: Session) -> dict:
    return {
        "id": message.id,
        "role": message.role,
        "text": message.text,
        "cards": refresh_cards(message.cards, session, message.project_id),
        "action": message.action,
        "refs": message.refs or [],
        "trace": with_points(message.trace),
        "can_regenerate": message.can_regenerate,
        "created_at": message.created_at.isoformat(),
    }
