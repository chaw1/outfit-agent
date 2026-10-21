import hashlib
import hmac
import math
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.errors import AppError
from app.models import User

bearer = HTTPBearer(auto_error=False)


def get_session():
    from app.observability import bind_session

    with SessionLocal() as session:
        bind_session(session)
        yield session


def hash_password(password: str) -> str:
    if len(password.encode()) > 72:
        raise AppError("INVALID_PASSWORD", "密码不能超过 72 字节", 422)
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    if len(password.encode()) > 72:
        return False
    return bcrypt.checkpw(password.encode(), hashed.encode())


def issue_token(user_id: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": user_id, "iat": now.timestamp(),
            "exp": (now + timedelta(days=settings.jwt_days)).timestamp(),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


def current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: Session = Depends(get_session),
) -> User:
    if not credentials:
        raise AppError("UNAUTHORIZED", "请先登录", 401)
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
        issued_at = float(payload.get("iat", 0))
        statement = select(User).where(User.id == payload["sub"])
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            # Serialize writes with password changes/deletion without blocking FK readers.
            statement = statement.with_for_update(key_share=True)
        user = session.scalar(statement.execution_options(populate_existing=True))
    except (jwt.PyJWTError, KeyError, TypeError, ValueError) as exc:
        raise AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401) from exc
    if user is None or user.deleted_at or not math.isfinite(issued_at):
        raise AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401)
    if user.password_updated_at:
        cutoff = user.password_updated_at
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=UTC)
        if issued_at < cutoff.timestamp():
            raise AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401)
    from app.observability import bind_user

    bind_user(request, user.id, session)
    if user.disabled and request.method not in {"GET", "HEAD", "OPTIONS"}:
        raise AppError("USER_DISABLED", "账号已被禁用，请联系管理员", 403)
    return user


def media_signature(asset_id: str, exp: int) -> str:
    return hmac.new(
        settings.jwt_secret.encode(), f"media:{asset_id}:{exp}".encode(), hashlib.sha256
    ).hexdigest()
