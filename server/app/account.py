"""Account lifecycle and public, versioned legal documents."""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import User, utcnow
from app.observability import bind_user
from app.schemas import AuthOutput, RegisterInput
from app.security import get_session, hash_password, issue_token
from app.views import user_dict

router = APIRouter(tags=["account"])
LEGAL_VERSION = "2026-10-21"
LEGAL_TITLES = {"terms": "用户协议", "privacy": "隐私政策", "disclaimer": "AI 内容免责声明"}
LEGAL_DIR = Path(__file__).parent / "legal"


class AccountRegisterInput(RegisterInput):
    agreed_legal_version: str = Field(default="", max_length=40)


@router.post("/api/auth/register", response_model=AuthOutput)
def register(
    body: AccountRegisterInput, request: Request, session: Session = Depends(get_session),
):
    user = User(
        username=body.username, password_hash=hash_password(body.password),
        nickname=body.nickname or body.username,
        legal_version=body.agreed_legal_version or None,
        legal_agreed_at=utcnow() if body.agreed_legal_version else None,
    )
    session.add(user)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise AppError("USERNAME_TAKEN", "用户名已被使用", 409) from exc
    bind_user(request, user.id, session)
    return {"token": issue_token(user.id), "user": user_dict(user, session)}


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
