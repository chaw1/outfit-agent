import hashlib
import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.media import signed_url
from app.models import Asset, Job, Message, Project, UsageLedger, User


def user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "created_at": user.created_at.isoformat(),
    }


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
            "script_version": job.payload.get("script_version"),
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
        if card.get("type") == "garments":
            card["items"] = [
                dict(item, url=signed_url(item["asset_id"])) for item in card.get("items", [])
            ]
        elif card.get("type") == "images":
            card["items"] = image_items(session, project_id)
        elif card.get("type") == "directions":
            card["options"] = direction_items(session, project_id, card.get("options", []))
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
        refreshed.append(card)
    return refreshed


def message_dict(message: Message, session: Session) -> dict:
    return {
        "id": message.id,
        "role": message.role,
        "text": message.text,
        "cards": refresh_cards(message.cards, session, message.project_id),
        "action": message.action,
        "created_at": message.created_at.isoformat(),
    }
