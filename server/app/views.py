from sqlalchemy import select
from sqlalchemy.orm import Session

from app.media import signed_url
from app.models import Asset, Job, Message, Project, User


def user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "created_at": user.created_at.isoformat(),
    }


def project_dict(project: Project, session: Session) -> dict:
    cover = session.scalar(
        select(Job)
        .where(
            Job.project_id == project.id, Job.status == "succeeded", Job.kind.in_(["image", "edit"])
        )
        .order_by(Job.created_at)
        .limit(1)
    )
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
        }
        for job in jobs
    ]


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
