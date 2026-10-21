"""Account lifecycle and public, versioned legal documents."""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.errors import AppError

router = APIRouter(tags=["account"])
LEGAL_VERSION = "2026-10-21"
LEGAL_TITLES = {"terms": "用户协议", "privacy": "隐私政策", "disclaimer": "AI 内容免责声明"}
LEGAL_DIR = Path(__file__).parent / "legal"


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
