"""Reusable personal models, garments and completed project images."""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from app.errors import AppError
from app.media import asset_dict, asset_path, persist_bytes
from app.models import AppSetting, Asset, Job, Project, User
from app.project_cleanup import CLEANUP_PREFIX, drain_media_cleanup, track_generated_file
from app.schemas import AssetOutput, StrictInput, UserOutput
from app.security import current_user, get_session
from app.views import user_dict

router = APIRouter(tags=["assets-library"])


class ModelFromImageInput(StrictInput):
    image_id: str = Field(min_length=1, max_length=100)
    name: str | None = Field(default=None, min_length=1, max_length=200)


class LibraryAssetOutput(AssetOutput):
    project_id: str | None
    project_title: str | None
    name: str | None = None
    in_profile: bool


class ModelFromImageOutput(BaseModel):
    asset: LibraryAssetOutput
    user: UserOutput


class LibraryAssetsOutput(BaseModel):
    items: list[LibraryAssetOutput]
    total: int


def completed_images(user_id: str):
    """Images use reference assets internally; only successful final jobs count."""
    return select(Asset, Project).join(Job, Job.result_asset_id == Asset.id).join(
        Project, Project.id == Job.project_id,
    ).where(
        Asset.user_id == user_id, Asset.source == "generated",
        Asset.project_id == Project.id, Asset.mime.startswith("image/"),
        Job.user_id == user_id, Job.kind.in_(["image", "edit"]), Job.status == "succeeded",
        or_(Job.payload["purpose"].as_string().is_(None),
            Job.payload["purpose"].as_string() != "preview"),
        Project.user_id == user_id, Project.deleted_at.is_(None),
    )


def library_asset(asset: Asset, project: Project | None, user: User) -> dict:
    return {
        **asset_dict(asset), "project_id": asset.project_id,
        "project_title": project.title if project else None,
        "name": (asset.analysis or {}).get("name"),
        "in_profile": asset.id in (user.profile or {}).get("model_asset_ids", []),
    }


@router.post("/api/me/models/from-image", response_model=ModelFromImageOutput)
def model_from_image(
    body: ModelFromImageInput, user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    found = session.execute(completed_images(user.id).where(or_(
        Job.id == body.image_id, Job.payload["image_id"].as_string() == body.image_id,
        Asset.id == body.image_id,
    ))).first()
    if found is None:
        raise AppError("NOT_FOUND", "成片不存在或尚未完成", 404)
    image, project = found
    # current_user holds the user's write lock through commit, including capacity checks.
    asset = session.scalar(select(Asset).where(
        Asset.user_id == user.id, Asset.kind == "model", Asset.source == "generated",
        Asset.parent_id == image.id,
    ).order_by(Asset.created_at, Asset.id).limit(1))
    profile = dict(user.profile or {})
    model_ids = list(profile.get("model_asset_ids", []))
    if asset is None or asset.id not in model_ids:
        if len(model_ids) >= 20:
            raise AppError("MODEL_LIMIT", "我的模特最多保存 20 张，请先移除一张再保存。", 422)
        if asset is None:
            try:
                data = asset_path(image).read_bytes()
            except FileNotFoundError as exc:
                raise AppError("NOT_FOUND", "成片文件不存在", 404) from exc
            relative = persist_bytes(data, image.mime)
            track_generated_file(session, relative)
            asset = Asset(
                user_id=user.id, project_id=project.id, kind="model", source="generated",
                parent_id=image.id, path=relative, mime=image.mime,
                width=image.width, height=image.height, model=image.model,
                analysis={"name": body.name if body.name is not None else project.title},
            )
            session.add(asset)
            session.flush()
        profile["model_asset_ids"] = [*model_ids, asset.id]
        user.profile = profile
    session.commit()
    return {"asset": library_asset(asset, project, user), "user": user_dict(user, session)}


@router.get("/api/me/assets", response_model=LibraryAssetsOutput)
def list_assets(
    kind: Literal["model", "garment", "image"],
    limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0),
    user: User = Depends(current_user), session: Session = Depends(get_session),
):
    query = completed_images(user.id) if kind == "image" else select(Asset, Project).outerjoin(
        Project, and_(Project.id == Asset.project_id, Project.user_id == user.id),
    ).where(
        Asset.user_id == user.id, Asset.kind == kind,
        # 用户在素材库里“删除”过的上传模特不再出现；文件和项目引用都还在。
        func.coalesce(Asset.analysis["library_hidden"].as_boolean(), False).is_(False),
    )
    unique_ids = query.with_only_columns(Asset.id).distinct().subquery()
    total = session.scalar(select(func.count()).select_from(unique_ids))
    rows = session.execute(query.distinct().order_by(
        Asset.created_at.desc(), Asset.id.desc(),
    ).limit(limit).offset(offset)).all()
    return {
        "items": [library_asset(asset, project, user) for asset, project in rows], "total": total,
    }


@router.delete("/api/me/assets/{asset_id}", status_code=204, response_class=Response)
def delete_asset(
    asset_id: str, user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    asset = session.scalar(select(Asset).where(Asset.id == asset_id, Asset.user_id == user.id))
    if asset is None:
        raise AppError("NOT_FOUND", "素材不存在", 404)
    if asset.kind == "model":
        if asset.source == "generated":
            # 正在被项目当出镜人用的成片模特不能删：排队中的出图还要靠它，删了会换人。
            titles = session.scalars(select(Project.title).where(
                Project.user_id == user.id, Project.deleted_at.is_(None),
                Project.model_asset_id == asset.id,
            ).order_by(Project.title, Project.id)).all()
            if titles:
                raise AppError(
                    "ASSET_IN_USE", "这位模特正在被以下项目使用：" + "、".join(titles) + "。", 409,
                )
        profile = dict(user.profile or {})
        profile["model_asset_ids"] = [
            item for item in profile.get("model_asset_ids", []) if item != asset.id
        ]
        user.profile = profile
        if asset.source == "upload":
            # Original uploads remain available to projects; only saved copies are removed.
            # 列表里不再展示，免得“已删除”之后再进来又看见它。
            asset.analysis = {**(asset.analysis or {}), "library_hidden": True}
            session.commit()
            return Response(status_code=204)
        session.execute(update(Project).where(
            Project.user_id == user.id, Project.model_asset_id == asset.id,
        ).values(model_asset_id=None))
    elif asset.kind == "garment" and asset.source == "upload":
        projects = session.scalars(select(Project).where(
            Project.user_id == user.id, Project.deleted_at.is_(None),
        ).order_by(Project.title, Project.id)).all()
        titles = [project.title for project in projects if asset.id in project.garment_asset_ids]
        if titles:
            raise AppError(
                "ASSET_IN_USE", "这件衣服正在被以下项目使用：" + "、".join(titles) + "。", 409,
            )
    else:
        raise AppError("PROJECT_ASSET", "成片随项目保存，请到项目中删除这组片。", 409)

    session.execute(update(Asset).where(Asset.parent_id == asset.id).values(parent_id=None))
    session.execute(update(Job).where(Job.result_asset_id == asset.id).values(result_asset_id=None))
    key = CLEANUP_PREFIX + "asset:" + asset.id
    session.add(AppSetting(key=key, value={"paths": [asset.path]}))
    session.delete(asset)
    session.commit()
    drain_media_cleanup(session, project_id="asset:" + asset_id)
    return Response(status_code=204)
