"""Account lifecycle and public, versioned legal documents."""

import re
import secrets
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import User, utcnow
from app.observability import bind_user
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
    username: str = Field(max_length=32)
    recovery_code: str
    new_password: str = Field(min_length=8, max_length=72)


class PasswordInput(StrictInput):
    password: str


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
        raise AppError("INVALID_CREDENTIALS", "密码不正确", 401)


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
