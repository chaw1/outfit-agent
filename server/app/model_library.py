"""模特库、兼容迁移与付费身份卡确认。"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import jwt
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.costs import image_cost_cny, points, seedream_image_cost_cny
from app.errors import AppError
from app.media import asset_dict
from app.models import Asset, Job, Model, Project, User
from app.runtime_settings import assert_generation_allowed, get_runtime_settings
from app.schemas import AssetOutput, StrictInput
from app.security import current_user, get_session

router = APIRouter(tags=["models"])
ANGLES = ("face", "full", "three-quarter", "half")
ANGLE_LABELS = ("正脸特写", "全身正面", "四分之三侧身", "半身微笑")
PRESETS = (
    (
        "a",
        "衣序模特 A",
        "成年女性，约22至28岁，鹅蛋脸，自然平眉、杏眼、直鼻梁、唇形饱满，"
        "自然冷白肤色，黑色中长直发中分，约168厘米、身形匀称，气质清冷干净。",
    ),
    (
        "b",
        "衣序模特 B",
        "成年女性，约24至30岁，椭圆脸偏瘦，细眉、笑眼、鼻梁挺直、唇形清晰，"
        "自然暖白肤色，黑色低马尾，约166厘米、体态轻盈，气质亲切明朗。",
    ),
    (
        "c",
        "衣序模特 C",
        "成年男性，约24至30岁，椭圆脸，平直浓眉、细长眼、直鼻梁、薄唇，"
        "自然中性肤色，黑色短发微分层，约180厘米、体型修长，气质干净松弛。",
    ),
)
FIXTURE_DIR = Path(__file__).parent / "fixtures" / "models"


def stable_id(key: str) -> str:
    return str(uuid5(NAMESPACE_URL, "outfit-model:" + key))


def seed_presets(session: Session) -> None:
    """Deterministic IDs and conflict-safe inserts make startup safe across API workers."""
    # Serialize all seeders without taking any user or project lock.
    if session.get_bind().dialect.name == "postgresql":
        session.execute(text("SELECT pg_advisory_xact_lock(182619361)"))
    for code, name, identity in PRESETS:
        model_id = stable_id("preset:" + code)
        if session.get(Model, model_id):
            continue
        ids = []
        for angle in ANGLES:
            filename = f"preset-{code}-{angle}.jpg"
            asset_id = stable_id(filename)
            if not session.get(Asset, asset_id):
                # Fixtures are immutable and served from the normal signed-media route.
                from PIL import Image

                with Image.open(FIXTURE_DIR / filename) as image:
                    width, height = image.size
                session.add(
                    Asset(
                        id=asset_id,
                        user_id=None,
                        kind="model",
                        path="models/" + filename,
                        mime="image/jpeg",
                        source="generated",
                        width=width,
                        height=height,
                    )
                )
            ids.append(asset_id)
        session.flush()
        session.add(
            Model(
                id=model_id,
                user_id=None,
                name=name,
                kind="preset",
                status="ready",
                identity_text=identity,
                face_asset_id=ids[0],
                sheet_asset_ids=ids,
            )
        )
    session.flush()


def migrate_legacy_models(session: Session, user: User) -> None:
    """One photo becomes one model. Tombstones prevent deleted models reappearing."""
    if session.get_bind().dialect.name == "postgresql":
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "model-migration:" + user.id},
        )
    profile_ids = (user.profile or {}).get("model_asset_ids", [])
    assets = session.scalars(
        select(Asset)
        .where(
            Asset.user_id == user.id,
            Asset.kind == "model",
            or_(Asset.id.in_(profile_ids), Asset.source == "generated"),
        )
        .order_by(Asset.created_at, Asset.id)
    ).all()
    known_faces = set(session.scalars(select(Model.face_asset_id).where(Model.user_id == user.id)))
    for asset in assets:
        if asset.id in known_faces or (asset.analysis or {}).get("identity_model_id"):
            continue
        model_id = stable_id("legacy:" + user.id + ":" + asset.id)
        if session.get(Model, model_id) or (asset.analysis or {}).get("library_hidden"):
            continue
        session.add(
            Model(
                id=model_id,
                user_id=user.id,
                name=(asset.analysis or {}).get("name") or "我的模特",
                kind="generated" if asset.source == "generated" else "own",
                status="ready",
                identity_text="",
                face_asset_id=asset.id,
                sheet_asset_ids=[asset.id],
            )
        )
    session.flush()


def available_model(session: Session, user_id: str, model_id: str) -> Model:
    model = session.get(Model, model_id)
    if (
        not model
        or (model.user_id != user_id and not (model.user_id is None and model.kind == "preset"))
        or model.status == "deleted"
    ):
        raise AppError("NOT_FOUND", "模特不存在或无权使用", 404)
    if model.status != "ready":
        raise AppError("MODEL_NOT_READY", "身份卡还没准备好，请完成后再选择。", 409)
    return model


def model_references(session: Session, project: Project) -> tuple[list[str], str]:
    if project.model_id:
        model = available_model(session, project.user_id, project.model_id)
        # The half portrait stays in the identity card; the three most useful
        # angles go to generation, preserving room for clothes and cover.
        ids = [model.face_asset_id, *model.sheet_asset_ids[1:3]]
        return list(dict.fromkeys(item for item in ids if item)), model.identity_text
    return ([project.model_asset_id] if project.model_asset_id else []), ""


def is_preset_asset(session: Session, asset_id: str) -> bool:
    return any(
        asset_id in model.sheet_asset_ids
        for model in session.scalars(
            select(Model).where(
                Model.user_id.is_(None),
                Model.kind == "preset",
                Model.status == "ready",
            )
        )
    )


class ModelOutput(BaseModel):
    id: str
    user_id: str | None
    name: str
    kind: str
    status: str
    identity_text: str
    face_asset_id: str | None
    sheet_asset_ids: list[str]
    face: AssetOutput | None
    sheets: list[dict]
    missing: list[str]
    job_id: str | None
    error: str | None
    created_at: datetime


class ModelsOutput(BaseModel):
    items: list[ModelOutput]
    total: int


def model_dict(session: Session, model: Model) -> dict:
    sheets = []
    for index, angle in enumerate(ANGLES):
        asset_id = model.sheet_asset_ids[index] if index < len(model.sheet_asset_ids) else None
        asset = session.get(Asset, asset_id) if asset_id else None
        sheets.append(
            {
                "angle": angle,
                "label": ANGLE_LABELS[index],
                "status": "ready" if asset else "missing",
                "asset": asset_dict(asset) if asset else None,
            }
        )
    face = session.get(Asset, model.face_asset_id) if model.face_asset_id else None
    job = (
        session.scalar(
            select(Job)
            .where(
                Job.user_id == model.user_id,
                Job.kind == "identity",
                Job.payload["model_id"].as_string() == model.id,
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        if model.user_id
        else None
    )
    return {
        "id": model.id,
        "user_id": model.user_id,
        "name": model.name,
        "kind": model.kind,
        "status": model.status,
        "identity_text": model.identity_text,
        "face_asset_id": model.face_asset_id,
        "sheet_asset_ids": model.sheet_asset_ids,
        "face": asset_dict(face) if face else None,
        "sheets": sheets,
        "missing": [sheet["angle"] for sheet in sheets if sheet["status"] == "missing"],
        "job_id": job.id if job else None,
        "error": job.error if job else None,
        "created_at": model.created_at,
    }


@router.get("/api/me/models", response_model=ModelsOutput)
def list_models(user: User = Depends(current_user), session: Session = Depends(get_session)):
    migrate_legacy_models(session, user)
    models = session.scalars(
        select(Model)
        .where(
            or_(Model.user_id == user.id, Model.user_id.is_(None) & (Model.kind == "preset")),
            Model.status != "deleted",
        )
        .order_by(Model.created_at, Model.id)
    ).all()
    result = {"items": [model_dict(session, model) for model in models], "total": len(models)}
    session.commit()
    return result


class IdentityInput(StrictInput):
    asset_ids: list[str] = Field(min_length=1, max_length=4)
    name: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("asset_ids")
    @classmethod
    def unique_assets(cls, value):
        if len(set(value)) != len(value) or any(not item.strip() for item in value):
            raise ValueError("身份卡照片不能为空或重复。")
        return value


class IdentityCreateInput(IdentityInput):
    confirmation_token: str = Field(min_length=1, max_length=4000)


class IdentityQuote(BaseModel):
    estimate_points: float
    generated_count: int
    confirmation_token: str
    breakdown: list[dict]


def identity_assets(session: Session, user: User, ids: list[str]) -> list[Asset]:
    assets = [session.get(Asset, asset_id) for asset_id in ids]
    if any(not asset or asset.user_id != user.id or asset.kind != "model" for asset in assets):
        raise AppError("INVALID_ASSET", "请只选择本人上传或保存的模特照片。", 422)
    return assets


def identity_quote_values(session: Session, count: int) -> tuple[dict, Decimal, Decimal]:
    models = get_runtime_settings(session)["models"]
    # Reserve for all four references and the vision model's maximum token tier.
    image = (
        seedream_image_cost_cny(4)
        if models["image"].startswith("doubao-seedream")
        else image_cost_cny()
    ) * (4 - count)
    vision = Decimal(16_384 * count * 3 + 800 * 30 + 3000) / 1_000_000
    return {key: models[key] for key in ("image", "vision")}, image, vision


@router.post("/api/me/models/quote", response_model=IdentityQuote)
def quote_identity(
    body: IdentityInput, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    identity_assets(session, user, body.asset_ids)
    models, image, vision = identity_quote_values(session, len(body.asset_ids))
    token = jwt.encode(
        {
            "purpose": "identity",
            "sub": user.id,
            **body.model_dump(),
            "models": models,
            "exp": datetime.now(UTC) + timedelta(minutes=15),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {
        "estimate_points": points(image + vision),
        "generated_count": 4 - len(body.asset_ids),
        "confirmation_token": token,
        "breakdown": [
            {"label": "补齐身份卡角度", "points": points(image)},
            {"label": "人物身份描述（上限）", "points": points(vision)},
        ],
    }


@router.post("/api/me/models", response_model=ModelOutput, status_code=202)
def create_identity(
    body: IdentityCreateInput,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        quote = jwt.decode(body.confirmation_token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise AppError("CONFIRMATION_REQUIRED", "请重新预估点数并确认建卡。", 409) from exc
    models, image, vision = identity_quote_values(session, len(body.asset_ids))
    if (
        quote.get("purpose") != "identity"
        or quote.get("sub") != user.id
        or quote.get("asset_ids") != body.asset_ids
        or quote.get("name") != body.name
        or quote.get("models") != models
    ):
        raise AppError("CONFIRMATION_REQUIRED", "照片或模型已变化，请重新预估并确认。", 409)
    model_id = stable_id("identity:" + user.id + ":" + body.confirmation_token)
    existing = session.get(Model, model_id)
    if existing:
        return model_dict(session, existing)
    assets = identity_assets(session, user, body.asset_ids)
    assert_generation_allowed(
        session,
        user.id,
        kinds=("image", "vision"),
        estimate=Decimal(0) if settings.mock_providers else image + vision,
    )
    model = Model(
        id=model_id,
        user_id=user.id,
        name=body.name or "我的身份卡",
        kind="own",
        status="queued",
        identity_text="",
        face_asset_id=assets[0].id,
        sheet_asset_ids=body.asset_ids,
    )
    session.add(model)
    session.add(
        Job(
            id=stable_id("identity-job:" + model_id),
            user_id=user.id,
            project_id=None,
            kind="identity",
            payload={"model_id": model_id, "models": models, "input_asset_ids": body.asset_ids},
            dedupe_key="identity:" + model_id,
        )
    )
    session.commit()
    return model_dict(session, model)


@router.delete("/api/me/models/{model_id}", status_code=204, response_class=Response)
def delete_model(
    model_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)
):
    model = session.get(Model, model_id)
    if not model or model.user_id != user.id:
        raise AppError("NOT_FOUND", "模特不存在或不能删除预置模特。", 404)
    if model.status in {"queued", "building"}:
        raise AppError("MODEL_IN_USE", "身份卡正在建立，请完成后再删除。", 409)
    if session.scalar(
        select(Project.id)
        .where(
            Project.model_id == model.id,
            Project.deleted_at.is_(None),
        )
        .limit(1)
    ):
        raise AppError("MODEL_IN_USE", "这位模特正在被片场使用，请先删除对应项目。", 409)
    model.status = "deleted"
    profile = dict(user.profile or {})
    profile["model_asset_ids"] = [
        item for item in profile.get("model_asset_ids", []) if item != model.face_asset_id
    ]
    user.profile = profile
    session.commit()
    return Response(status_code=204)
