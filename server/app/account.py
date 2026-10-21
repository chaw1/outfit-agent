"""Account lifecycle and public, versioned legal documents."""

import hashlib
import re
import secrets
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import AppSetting, Asset, Job, Project, User, utcnow
from app.observability import bind_user
from app.project_cleanup import CLEANUP_PREFIX, cleanup_project, drain_media_cleanup
from app.rate_limits import check_limit
from app.schemas import AuthOutput, RegisterInput, StrictInput
from app.security import current_user, get_session, hash_password, issue_token, verify_password
from app.views import user_dict

router = APIRouter(tags=["account"])
LEGAL_VERSION = "2026-10-21"
LEGAL_TITLES = {"terms": "用户协议", "privacy": "隐私政策", "disclaimer": "AI 内容免责声明"}
LEGAL_DIR = Path(__file__).parent / "legal"
RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_DUMMY_RECOVERY_HASH = hash_password(secrets.token_hex(16))


class AccountRegisterInput(RegisterInput):
    agreed_legal_version: str = Field(default="", max_length=40)


class RecoveryAuthOutput(AuthOutput):
    recovery_code: str


class RecoveryInput(StrictInput):
    username: str
    recovery_code: str
    new_password: str = Field(min_length=8, max_length=72)


class PasswordInput(StrictInput):
    password: str


class PasswordChangeInput(StrictInput):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class RecoveryCodeOutput(BaseModel):
    recovery_code: str


def rotate_recovery_code(user: User) -> str:
    raw = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(12))
    user.recovery_code_hash = hash_password(raw)
    return "-".join(raw[offset:offset + 4] for offset in range(0, 12, 4))


def locked_user(session: Session, user_id: str) -> User:
    user = session.scalar(
        select(User).where(User.id == user_id).with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if user is None or user.deleted_at:
        raise AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401)
    return user


def check_password(user: User, password: str) -> None:
    if not verify_password(password, user.password_hash):
        # 400 而不是 401：这是业务校验失败，登录态仍然有效，客户端不能因此退出登录。
        raise AppError("INVALID_PASSWORD", "密码不正确，请再试一次", 400)


def replace_password(user: User, password: str) -> None:
    user.password_hash = hash_password(password)
    user.password_updated_at = utcnow()


@router.post("/api/auth/register", response_model=RecoveryAuthOutput)
def register(
    body: AccountRegisterInput, request: Request, response: Response,
    session: Session = Depends(get_session),
):
    user = User(
        username=body.username, password_hash=hash_password(body.password),
        nickname=body.nickname or body.username,
        legal_version=body.agreed_legal_version or None,
        legal_agreed_at=utcnow() if body.agreed_legal_version else None,
    )
    recovery_code = rotate_recovery_code(user)
    session.add(user)
    try:
        session.flush()
        token = issue_token(user.id)
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AppError("USERNAME_TAKEN", "用户名已被使用", 409) from exc
    bind_user(request, user.id, session)
    response.headers["Cache-Control"] = "no-store"
    return {
        "token": token, "user": user_dict(user, session),
        "recovery_code": recovery_code,
    }


@router.post("/api/auth/recover", response_model=RecoveryAuthOutput)
def recover(
    body: RecoveryInput, request: Request, response: Response,
    session: Session = Depends(get_session),
):
    check_limit("recover", body.username)
    user = session.scalar(
        select(User).where(User.username == body.username).with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    raw = body.recovery_code.strip().lower().replace("-", "")
    usable = user is not None and not user.deleted_at and not user.disabled
    hashed = user.recovery_code_hash if usable else None
    valid = bool(re.fullmatch(r"[a-z0-9]{12}", raw)) and verify_password(
        raw, hashed or _DUMMY_RECOVERY_HASH,
    )
    if not hashed or not valid:
        raise AppError("RECOVERY_FAILED", "用户名或恢复码不正确", 401)
    replace_password(user, body.new_password)
    recovery_code = rotate_recovery_code(user)
    token = issue_token(user.id)
    session.commit()
    bind_user(request, user.id, session)
    response.headers["Cache-Control"] = "no-store"
    return {
        "token": token, "user": user_dict(user, session),
        "recovery_code": recovery_code,
    }


@router.post("/api/me/recovery-code", response_model=RecoveryCodeOutput)
def regenerate_recovery_code(
    body: PasswordInput, response: Response, user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    user = locked_user(session, user.id)
    check_password(user, body.password)
    recovery_code = rotate_recovery_code(user)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"recovery_code": recovery_code}


@router.post("/api/me/password", response_model=AuthOutput)
def change_password(
    body: PasswordChangeInput, response: Response, user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    user = locked_user(session, user.id)
    check_password(user, body.current_password)
    replace_password(user, body.new_password)
    token = issue_token(user.id)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"token": token, "user": user_dict(user, session)}


@router.delete("/api/me", status_code=204, response_class=Response)
def delete_account(
    body: PasswordInput, user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    user = locked_user(session, user.id)
    check_password(user, body.password)
    projects = session.scalars(
        select(Project).where(Project.user_id == user.id).order_by(Project.id)
    ).all()
    if session.get_bind().dialect.name == "postgresql":
        for project in projects:
            # Match the existing conversation lock before taking publication row locks.
            lock_id = int.from_bytes(
                hashlib.sha256(project.id.encode()).digest()[:8], "big", signed=True,
            )
            session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
    for project in projects:
        cleanup_project(session, project, commit=False)
        project.title, project.brand, project.brief = "已注销账号的项目", "", ""
        project.garment_asset_ids, project.reference_asset_ids = [], []
        project.model_asset_id = None

    # Project deletion preserves reusable uploads; account deletion removes these too.
    remaining = session.execute(select(Asset.id, Asset.path).where(Asset.user_id == user.id)).all()
    asset_ids = [asset_id for asset_id, _ in remaining]
    session.execute(delete(Job).where(Job.user_id == user.id))
    if asset_ids:
        session.execute(update(Asset).where(Asset.parent_id.in_(asset_ids)).values(parent_id=None))
        session.execute(
            update(Project).where(Project.model_asset_id.in_(asset_ids)).values(model_asset_id=None)
        )
        session.execute(
            update(Job).where(Job.result_asset_id.in_(asset_ids)).values(result_asset_id=None)
        )
        session.execute(delete(Asset).where(Asset.user_id == user.id))
        key = CLEANUP_PREFIX + "account:" + user.id
        paths = list(dict.fromkeys(path for _, path in remaining))
        entry = session.get(AppSetting, key)
        if entry is None:
            session.add(AppSetting(key=key, value={"paths": paths}))
        else:
            entry.value = {"paths": list(dict.fromkeys([*entry.value.get("paths", []), *paths]))}

    # Do not update this unique key until all conversation/publication locks are held.
    tombstone = "deleted-" + user.id[:8]
    if session.scalar(select(User.id).where(User.username == tombstone, User.id != user.id)):
        tombstone += "-" + secrets.token_hex(4)
    user.username, user.nickname, user.profile = tombstone, "已注销", {}
    user.deleted_at = user.password_updated_at = utcnow()
    user.disabled = True
    user.password_hash = hash_password(secrets.token_urlsafe(32))
    user.recovery_code_hash = None
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AppError("ACCOUNT_DELETE_CONFLICT", "注销未完成，请重试", 409) from exc
    for project in projects:
        drain_media_cleanup(session, project_id=project.id)
    drain_media_cleanup(session, project_id="account:" + user.id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


class LegalSummary(BaseModel):
    kind: Literal["terms", "privacy", "disclaimer"]
    title: str
    version: str


class LegalDocument(LegalSummary):
    markdown: str


@router.get("/api/legal", response_model=list[LegalSummary])
def legal_index():
    return [
        {"kind": kind, "title": title, "version": LEGAL_VERSION}
        for kind, title in LEGAL_TITLES.items()
    ]


@router.get("/api/legal/{kind}", response_model=LegalDocument)
def legal_document(kind: str):
    if kind not in LEGAL_TITLES:
        raise AppError("NOT_FOUND", "法律文本不存在", 404)
    return {
        "kind": kind, "title": LEGAL_TITLES[kind], "version": LEGAL_VERSION,
        "markdown": (LEGAL_DIR / f"{kind}.md").read_text(encoding="utf-8"),
    }
