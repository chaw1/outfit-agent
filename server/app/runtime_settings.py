"""Database-backed model choices and Shanghai-day generation quotas.

Reads deliberately have no cache: API and independent workers see a committed
setting on their next call, including when a Session already has ORM objects.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError
from app.models import AppSetting, UsageLedger, User

RUNTIME_KEY = "runtime"
BUDGET_LOCK_ID = 708827141
MODEL_CANDIDATES = {
    "text": ["deepseek-flash", "deepseek-chat"],
    "vision": ["qwen3-vl-plus", "qwen-vl-plus"],
    "image": ["wan2.7-image-pro", "wan2.6-image"],
    "video": ["wan2.6-i2v-flash", "wan2.6-i2v"],
}


def model_candidates() -> dict[str, list[str]]:
    return {
        kind: list(dict.fromkeys([getattr(settings, f"{kind}_model"), *models]))
        for kind, models in MODEL_CANDIDATES.items()
    }


def default_runtime_settings() -> dict:
    cap = float(settings.model_budget_cny)
    models = {kind: getattr(settings, f"{kind}_model") for kind in MODEL_CANDIDATES}
    available = list(
        dict.fromkeys(model for group in model_candidates().values() for model in group)
    )
    return {
        "models": models,
        "tiers": {
            "free": {"daily_budget_cny": cap, "models": list(available)},
            "pro": {"daily_budget_cny": cap * 10, "models": list(available)},
        },
        "global_daily_budget_cny": cap * 100,
    }


def get_runtime_settings(session: Session) -> dict:
    # Select scalar columns rather than an identity-mapped AppSetting instance.
    with session.no_autoflush:
        stored = session.scalar(select(AppSetting.value).where(AppSetting.key == RUNTIME_KEY))
    return stored if stored is not None else default_runtime_settings()


def validate_runtime_settings(body: dict) -> dict:
    def invalid(message="模型与配额设置无效，请检查后重试。"):
        raise AppError("invalid_settings", message, 422)

    def budget(value):
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float, Decimal))
            or not math.isfinite(float(value))
            or not 0 <= float(value) <= 1_000_000
        ):
            invalid("每日预算须为 0 到 1000000 之间的金额。")
        return float(value)

    if not isinstance(body, dict) or set(body) != {
        "models", "tiers", "global_daily_budget_cny"
    }:
        invalid()
    models, tiers = body["models"], body["tiers"]
    candidates = model_candidates()
    if not isinstance(models, dict) or set(models) != set(candidates):
        invalid("请完整设置对话、看图、出图和视频模型。")
    for kind, model in models.items():
        if not isinstance(model, str) or model not in candidates[kind]:
            invalid("请选择候选列表中的模型。")
    if not isinstance(tiers, dict) or set(tiers) != {"free", "pro"}:
        invalid("请完整设置 free 和 pro 层级。")
    allowed = {model for group in candidates.values() for model in group}
    normalized_tiers = {}
    for name, tier in tiers.items():
        if not isinstance(tier, dict) or set(tier) != {"daily_budget_cny", "models"}:
            invalid()
        choices = tier["models"]
        if (
            not isinstance(choices, list)
            or any(not isinstance(model, str) or model not in allowed for model in choices)
            or len(set(choices)) != len(choices)
        ):
            invalid("层级可用模型必须来自候选列表且不能重复。")
        normalized_tiers[name] = {
            "daily_budget_cny": budget(tier["daily_budget_cny"]),
            "models": list(choices),
        }
    return {
        "models": dict(models),
        "tiers": normalized_tiers,
        "global_daily_budget_cny": budget(body["global_daily_budget_cny"]),
    }


def save_runtime_settings(session: Session, body: dict) -> dict:
    normalized = validate_runtime_settings(body)
    row = session.get(AppSetting, RUNTIME_KEY)
    if row is None:
        row = AppSetting(key=RUNTIME_KEY, value=normalized)
        session.add(row)
    else:
        row.value = normalized
    session.flush()
    return normalized


def day_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    local = (now or datetime.now(UTC)).astimezone(ZoneInfo("Asia/Shanghai"))
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def budget_lock(session: Session) -> None:
    """Same short accounting lock is shared by API/worker reservations."""
    if session.get_bind().dialect.name == "postgresql":
        session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": BUDGET_LOCK_ID})


def today_cost_cny(session: Session, user_id: str | None = None) -> Decimal:
    """Count accepted, failed and reserved calls using the same Shanghai day."""
    start, end = day_bounds()
    query = select(func.coalesce(func.sum(UsageLedger.estimated_cny), 0)).where(
        UsageLedger.created_at >= start, UsageLedger.created_at < end
    )
    if user_id is not None:
        query = query.where(UsageLedger.user_id == user_id)
    return Decimal(str(session.scalar(query)))


def user_budget(user: User, session: Session | None = None) -> dict:
    config = get_runtime_settings(session) if session is not None else default_runtime_settings()
    tier = user.tier or "free"
    cap = Decimal(str(config["tiers"].get(tier, config["tiers"]["free"])["daily_budget_cny"]))
    spent = today_cost_cny(session, user.id) if session is not None else Decimal(0)
    return {
        "tier": tier,
        "daily_budget_cny": float(cap),
        "today_cost_cny": round(float(spent), 6),
        "remaining_cny": round(float(max(cap - spent, Decimal(0))), 6),
    }


def assert_generation_allowed(
    session: Session,
    user_id: str | None,
    *,
    kinds: tuple[str, ...] = ("image",),
    estimate: Decimal = Decimal(0),
    check_budget: bool = True,
) -> dict:
    """Check current tier and spend; caller serializes paid reservations.

    Existing reservations count as spend, so concurrent submissions cannot all
    take the last remaining allowance. Conversation/vision calls set
    check_budget=False; their usage is still included in daily totals.
    """
    config = get_runtime_settings(session)
    tier = None
    if user_id:
        row = session.execute(select(User.tier, User.disabled).where(User.id == user_id)).first()
        if row is None or row.disabled:
            raise AppError("USER_DISABLED", "账号已禁用，请联系管理员。", 403)
        tier = config["tiers"].get(row.tier, config["tiers"]["free"])
        if any(config["models"][kind] not in tier["models"] for kind in kinds):
            raise AppError("MODEL_NOT_ALLOWED", "当前账号层级暂不能使用该模型，请联系管理员。", 403)
    if not check_budget:
        return config
    global_spent = today_cost_cny(session)
    global_cap = Decimal(str(config["global_daily_budget_cny"]))
    if global_spent >= global_cap or global_spent + estimate > global_cap:
        raise AppError("BUDGET_EXCEEDED", "今日全局模型预算已用完，请明天再试或联系管理员。", 403)
    if tier is not None:
        spent = today_cost_cny(session, user_id)
        cap = Decimal(str(tier["daily_budget_cny"]))
        if spent >= cap or spent + estimate > cap:
            raise AppError(
                "BUDGET_EXCEEDED", "今日账号模型预算已用完，请明天再试或联系管理员。", 403
            )
    return config
