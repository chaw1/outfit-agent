"""管理端专用会话与运营 API。"""

import csv
import hashlib
import hmac
import io
import json
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

import jwt
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.models import Job, Model, Project, UsageLedger, User, utcnow
from app.observability import request_totals
from app.runtime_settings import (
    assert_generation_allowed,
    day_bounds,
    get_runtime_settings,
    model_candidates,
    save_runtime_settings,
)
from app.security import get_session
from app.worker import _completion_lock, _notify_completion

ADMIN_AUDIENCE = "outfit-admin"
ADMIN_SESSION_SECONDS = 8 * 3600
LOCAL_TIMEZONE = ZoneInfo("Asia/Shanghai")
admin_bearer = HTTPBearer(auto_error=False, scheme_name="AdminSession")


def admin_enabled() -> None:
    if not settings.admin_token:
        raise AppError("NOT_FOUND", "页面不存在", 404)


def _session_key() -> bytes:
    return hmac.new(
        settings.jwt_secret.encode(),
        ("admin-session:" + settings.admin_token).encode(),
        hashlib.sha256,
    ).digest()


def require_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(admin_bearer),
    enabled: None = Depends(admin_enabled),
) -> None:
    if credentials:
        try:
            payload = jwt.decode(
                credentials.credentials,
                _session_key(),
                algorithms=["HS256"],
                audience=ADMIN_AUDIENCE,
                options={"require": ["exp", "iat", "aud", "kind"]},
            )
            if payload["kind"] == "admin":
                return
        except jwt.PyJWTError:
            pass
    raise AppError("ADMIN_UNAUTHORIZED", "请先登录管理端", 401)


router = APIRouter(prefix="/api/admin", tags=["管理端"], dependencies=[Depends(admin_enabled)])


class AdminLogin(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class AdminSession(BaseModel):
    token: str
    expires_in: int


class Aggregate(BaseModel):
    calls: int
    cost_cny: float


class StageCount(BaseModel):
    stage: str
    count: int


class QueueCounts(BaseModel):
    queued: int
    running: int
    failed: int
    succeeded: int = 0
    cancelled: int = 0


class TrendPoint(BaseModel):
    day: date
    calls: int
    cost_cny: float


class Overview(BaseModel):
    users: int
    projects: int
    today: Aggregate
    total: Aggregate
    stages: list[StageCount]
    jobs: QueueCounts
    requests_24h: int
    errors_24h: int
    trend: list[TrendPoint] = []
    by_model: list["UsageRow"] = []
    success_rate: float | None = None


class UsageRow(BaseModel):
    key: str
    label: str
    calls: int
    duration_ms: int
    cost_cny: float


class UsageReport(BaseModel):
    group: Literal["model", "user", "day"]
    from_date: date = Field(alias="from")
    to: date
    user_id: str | None
    rows: list[UsageRow]


class Models(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    vision: str
    image: str
    video: str


class Tier(BaseModel):
    model_config = ConfigDict(extra="forbid")
    daily_budget_cny: float = Field(ge=0, allow_inf_nan=False)
    models: list[str]


class Tiers(BaseModel):
    model_config = ConfigDict(extra="forbid")
    free: Tier
    pro: Tier


class RuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    models: Models
    tiers: Tiers
    global_daily_budget_cny: float = Field(ge=0, allow_inf_nan=False)


class SettingsOutput(RuntimeSettings):
    candidates: dict[str, list[str]]


class AdminJob(BaseModel):
    id: str
    project_id: str | None
    project_title: str
    user_id: str
    username: str
    kind: str
    status: str
    attempts: int
    error: str | None
    duration_ms: int
    created_at: datetime
    updated_at: datetime
    cancelled: bool
    photo_prompt: str | None = None


class AdminUser(BaseModel):
    id: str
    username: str
    nickname: str
    created_at: datetime
    project_count: int
    cost_cny: float
    tier: str
    disabled: bool
    deleted_at: datetime | None = None


class UserPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tier: Literal["free", "pro"] | None = None
    disabled: bool | None = None


@router.post("/login", response_model=AdminSession)
def login(body: AdminLogin):
    if not hmac.compare_digest(body.token.encode(), settings.admin_token.encode()):
        raise AppError("ADMIN_UNAUTHORIZED", "管理口令不正确", 401)
    now = utcnow()
    return {
        "token": jwt.encode(
            {
                "kind": "admin",
                "aud": ADMIN_AUDIENCE,
                "iat": now,
                "exp": now + timedelta(seconds=ADMIN_SESSION_SECONDS),
            },
            _session_key(),
            algorithm="HS256",
        ),
        "expires_in": ADMIN_SESSION_SECONDS,
    }


def _usage_totals(session: Session, *conditions) -> dict:
    count, cost = session.execute(
        select(func.count(UsageLedger.id), func.coalesce(func.sum(UsageLedger.estimated_cny), 0))
        .where(*conditions)
    ).one()
    return {"calls": count, "cost_cny": float(cost)}


@router.get("/overview", response_model=Overview, dependencies=[Depends(require_admin)])
def overview(session: Session = Depends(get_session)):
    start, end = day_bounds()
    stages = session.execute(
        select(Project.stage, func.count()).where(Project.deleted_at.is_(None))
        .group_by(Project.stage).order_by(Project.stage)
    ).all()
    jobs = dict(session.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    finished = jobs.get("succeeded", 0) + jobs.get("failed", 0)
    today = datetime.now(LOCAL_TIMEZONE).date()
    week = _usage_report(session, "day", today - timedelta(days=6), today, None)["rows"]
    by_day = {row["key"]: row for row in week}
    trend = []
    for offset in range(6, -1, -1):
        day = today - timedelta(days=offset)
        row = by_day.get(str(day)) or {"calls": 0, "cost_cny": 0.0}
        trend.append({"day": day, "calls": row["calls"], "cost_cny": row["cost_cny"]})
    by_model = sorted(
        _usage_report(session, "model", today - timedelta(days=6), today, None)["rows"],
        key=lambda row: row["cost_cny"], reverse=True,
    )
    return {
        **request_totals(session),
        "trend": trend,
        "by_model": by_model,
        "success_rate": (jobs.get("succeeded", 0) / finished) if finished else None,
        "users": session.scalar(select(func.count(User.id))),
        "projects": sum(count for stage, count in stages),
        "today": _usage_totals(
            session, UsageLedger.created_at >= start, UsageLedger.created_at < end
        ),
        "total": _usage_totals(session),
        "stages": [{"stage": stage, "count": count} for stage, count in stages],
        "jobs": {
            key: jobs.get(key, 0)
            for key in ("queued", "running", "failed", "succeeded", "cancelled")
        },
    }


def _usage_report(
    session: Session, group: str, from_date: date | None, to_date: date | None,
    user_id: str | None,
) -> dict:
    today = datetime.now(LOCAL_TIMEZONE).date()
    to_date = to_date or today
    from_date = from_date or to_date - timedelta(days=29)
    if from_date > to_date:
        raise AppError("INVALID_DATE_RANGE", "开始日期不能晚于结束日期", 422)
    start = datetime.combine(from_date, time.min, LOCAL_TIMEZONE).astimezone(UTC)
    end = datetime.combine(to_date + timedelta(days=1), time.min, LOCAL_TIMEZONE).astimezone(UTC)
    conditions = [UsageLedger.created_at >= start, UsageLedger.created_at < end]
    if user_id:
        conditions.append(UsageLedger.user_id == user_id)
    if group == "day":
        if session.get_bind().dialect.name == "postgresql":
            key = func.date(func.timezone("Asia/Shanghai", UsageLedger.created_at))
        else:
            key = func.date(UsageLedger.created_at, "+8 hours")
    else:
        key = UsageLedger.model if group == "model" else UsageLedger.user_id
    statement = select(
        key.label("group_key"), func.count(UsageLedger.id),
        func.coalesce(func.sum(UsageLedger.duration_ms), 0),
        func.coalesce(func.sum(UsageLedger.estimated_cny), 0),
    ).where(*conditions).group_by(key).order_by(key)
    usernames = (
        dict(session.execute(select(User.id, User.username)).all()) if group == "user" else {}
    )
    rows = []
    for value, calls, duration, cost in session.execute(statement):
        label = usernames.get(value, "未归属用户") if group == "user" else str(value)
        rows.append({
            "key": str(value) if value is not None else "unattributed",
            "label": label, "calls": calls, "duration_ms": duration, "cost_cny": float(cost),
        })
    return {"group": group, "from": from_date, "to": to_date, "user_id": user_id, "rows": rows}


@router.get("/usage", response_model=UsageReport, dependencies=[Depends(require_admin)])
def usage(
    group: Literal["model", "user", "day"] = "model",
    from_date: date | None = Query(None, alias="from"),
    to: date | None = None,
    user_id: str | None = None,
    session: Session = Depends(get_session),
):
    return _usage_report(session, group, from_date, to, user_id)


def _csv_cell(value: str) -> str:
    # Spreadsheet programs must not execute user-controlled names as formulas.
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value


@router.get(
    "/usage.csv", dependencies=[Depends(require_admin)], response_class=Response,
    responses={200: {"content": {"text/csv": {"schema": {"type": "string"}}}}},
)
def usage_csv(
    group: Literal["model", "user", "day"] = "model",
    from_date: date | None = Query(None, alias="from"),
    to: date | None = None,
    user_id: str | None = None,
    session: Session = Depends(get_session),
):
    report = _usage_report(session, group, from_date, to, user_id)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["分组", "名称", "调用次数", "耗时毫秒", "估算费用元"])
    for row in report["rows"]:
        writer.writerow([
            group, _csv_cell(row["label"]), row["calls"], row["duration_ms"], row["cost_cny"]
        ])
    return Response(
        "\ufeff" + output.getvalue(), media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="usage.csv"', "Cache-Control": "no-store"
        },
    )


@router.get("/settings", response_model=SettingsOutput, dependencies=[Depends(require_admin)])
def get_settings(session: Session = Depends(get_session)):
    return {**get_runtime_settings(session), "candidates": model_candidates()}


@router.put("/settings", response_model=SettingsOutput, dependencies=[Depends(require_admin)])
def update_settings(body: RuntimeSettings, session: Session = Depends(get_session)):
    value = save_runtime_settings(session, body.model_dump())
    session.commit()
    return {**value, "candidates": model_candidates()}


def _job_output(job: Job, project: Project | None, user: User) -> dict:
    start, end = job.locked_at or job.created_at, job.updated_at
    # SQLite unit tests return naive UTC timestamps; production uses timestamptz.
    if start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    if end.tzinfo is None:
        end = end.replace(tzinfo=UTC)
    if job.status in {"queued", "running"}:
        end = utcnow()
    photo_prompt = job.payload.get("photo_prompt")
    if isinstance(photo_prompt, dict):
        photo_prompt = json.dumps(photo_prompt, ensure_ascii=False, indent=2)
    return {
        "id": job.id, "project_id": job.project_id,
        "project_title": project.title if project else "模特身份卡",
        "user_id": job.user_id, "username": user.username, "kind": job.kind,
        "status": job.status, "attempts": job.attempts, "error": job.error,
        "duration_ms": job.result.get(
            "duration_ms", max(0, int((end - start).total_seconds() * 1000))
        ),
        "created_at": job.created_at, "updated_at": job.updated_at,
        "cancelled": bool(job.result.get("admin_cancelled")),
        "photo_prompt": photo_prompt,
    }


@router.get("/jobs", response_model=list[AdminJob], dependencies=[Depends(require_admin)])
def jobs(
    status: Literal["queued", "running", "succeeded", "failed"] | None = None,
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    statement = select(Job, Project, User).outerjoin(Project, Job.project_id == Project.id).join(
        User, Job.user_id == User.id
    ).order_by(Job.created_at.desc()).limit(limit)
    if status:
        statement = statement.where(Job.status == status)
    return [_job_output(*row) for row in session.execute(statement)]


def _locked_job(session: Session, job_id: str) -> tuple[Job, Project | None, User]:
    snapshot = session.get(Job, job_id)
    if not snapshot:
        raise AppError("NOT_FOUND", "任务不存在", 404)
    # Keep the worker's batch-before-row lock order to prevent completion deadlocks.
    _completion_lock(session, snapshot)
    job = session.scalar(
        select(Job).where(Job.id == job_id).with_for_update()
        .execution_options(populate_existing=True)
    )
    project = session.get(Project, job.project_id) if job.project_id else None
    user = session.get(User, job.user_id)
    if not user or (job.kind != "identity" and (not project or project.deleted_at)):
        raise AppError("NOT_FOUND", "任务所属项目或用户不存在", 404)
    return job, project, user


@router.post("/jobs/{job_id}/retry", response_model=AdminJob, dependencies=[Depends(require_admin)])
def retry_job(job_id: str, session: Session = Depends(get_session)):
    job, project, user = _locked_job(session, job_id)
    if job.status != "failed" or job.result.get("admin_cancelled"):
        raise AppError("JOB_STATE_CONFLICT", "只能重试失败且未取消的任务", 409)
    if job.result.get("external_request_started") and not job.payload.get("provider_task_id"):
        raise AppError("JOB_RESULT_UNKNOWN", "上次生成结果未知，不能重复提交可能计费的请求", 409)
    assert_generation_allowed(
        session, user.id, kinds=("video" if job.kind == "video" else "image",)
    )
    job.status, job.attempts, job.error, job.locked_at = "queued", 0, None, None
    job.available_at = utcnow()
    job.result, job.result_asset_id = {}, None
    if job.kind == "identity":
        model = session.get(Model, job.payload["model_id"])
        if not model or model.status == "deleted":
            raise AppError("NOT_FOUND", "模特已不存在", 404)
        model.status = "queued"
    session.commit()
    return _job_output(job, project, user)


@router.post(
    "/jobs/{job_id}/cancel", response_model=AdminJob, dependencies=[Depends(require_admin)]
)
def cancel_job(job_id: str, session: Session = Depends(get_session)):
    job, project, user = _locked_job(session, job_id)
    if job.status != "queued":
        raise AppError("JOB_STATE_CONFLICT", "只能取消排队中的任务", 409)
    job.status, job.locked_at, job.error = "failed", None, "管理员已取消任务。"
    job.result = {**job.result, "cancelled": True, "admin_cancelled": True}
    if job.kind == "identity":
        model = session.get(Model, job.payload["model_id"])
        if model and model.status != "deleted":
            model.status = "failed"
    else:
        _notify_completion(session, job)
    session.commit()
    return _job_output(job, project, user)


def _users_statement():
    projects = select(
        Project.user_id, func.count(Project.id).label("project_count")
    ).where(Project.deleted_at.is_(None)).group_by(Project.user_id).subquery()
    usage = select(
        UsageLedger.user_id, func.sum(UsageLedger.estimated_cny).label("cost_cny")
    ).group_by(UsageLedger.user_id).subquery()
    return select(
        User, func.coalesce(projects.c.project_count, 0), func.coalesce(usage.c.cost_cny, 0)
    ).outerjoin(projects, projects.c.user_id == User.id).outerjoin(
        usage, usage.c.user_id == User.id
    )


def _user_output(user: User, project_count: int, cost_cny) -> dict:
    return {
        "id": user.id, "username": user.username, "nickname": user.nickname,
        "created_at": user.created_at, "project_count": project_count, "cost_cny": float(cost_cny),
        "tier": user.tier, "disabled": user.disabled, "deleted_at": user.deleted_at,
    }


@router.get("/users", response_model=list[AdminUser], dependencies=[Depends(require_admin)])
def users(q: str = "", session: Session = Depends(get_session)):
    statement = _users_statement().order_by(User.created_at.desc())
    if q:
        needle = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        statement = statement.where(
            User.username.ilike(needle, escape="\\") | User.nickname.ilike(needle, escape="\\")
        )
    return [_user_output(*row) for row in session.execute(statement)]


@router.patch("/users/{user_id}", response_model=AdminUser, dependencies=[Depends(require_admin)])
def update_user(user_id: str, body: UserPatch, session: Session = Depends(get_session)):
    user = session.scalar(select(User).where(User.id == user_id).with_for_update())
    if not user:
        raise AppError("NOT_FOUND", "用户不存在", 404)
    if body.tier is not None:
        user.tier = body.tier
    if body.disabled is not None:
        user.disabled = body.disabled
    session.commit()
    return _user_output(*session.execute(_users_statement().where(User.id == user_id)).one())
