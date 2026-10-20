"""Personal profile writes and safe default-photo selection."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Asset, User
from app.schemas import Profile, UserProfilePatch


def _owned_model_ids(session: Session, user: User, asset_ids: list[str]) -> set[str]:
    if not asset_ids:
        return set()
    return set(session.scalars(select(Asset.id).where(
        Asset.id.in_(asset_ids),
        Asset.user_id == user.id,
        Asset.kind == "model",
        Asset.source == "upload",
    )))


def patch_user(session: Session, user: User, body: UserProfilePatch) -> None:
    """Merge supplied fields only; validate everything before changing the user."""
    profile = dict(user.profile or {})
    if body.profile is not None:
        supplied = body.profile.model_dump(exclude_unset=True)
        if "model_asset_ids" in supplied:
            asset_ids = supplied["model_asset_ids"]
            if _owned_model_ids(session, user, asset_ids) != set(asset_ids):
                raise AppError(
                    "invalid_profile_asset", "档案照片必须是本人上传的形象照片（kind=model）。", 422
                )
        profile.update(supplied)
        profile = Profile.model_validate(profile).model_dump(exclude_none=True)
    if "nickname" in body.model_fields_set:
        user.nickname = body.nickname
    if "profile" in body.model_fields_set:
        user.profile = profile
    session.flush()


def default_model_asset_id(session: Session, user: User) -> str | None:
    asset_ids = (user.profile or {}).get("model_asset_ids", [])
    owned = _owned_model_ids(session, user, asset_ids)
    return next((asset_id for asset_id in asset_ids if asset_id in owned), None)
