"""Database-serialized request counters shared by every API process."""

import hashlib
import time

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import Column, Integer, MetaData, String, Table, case
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import SessionLocal
from app.errors import AppError
from app.models import User
from app.security import current_user

metadata = MetaData()
counters = Table(
    "rate_limit_counters",
    metadata,
    Column("key", String(100), primary_key=True),
    Column("window", Integer, nullable=False),
    Column("count", Integer, nullable=False),
)


def check_limit(category: str, subject: str, *, session_factory=None, now=None) -> None:
    window = int(time.time() if now is None else now) // settings.rate_limit_window_seconds
    key = category + ":" + hashlib.sha256(subject.encode()).hexdigest()
    limit = getattr(settings, f"rate_limit_{category}")
    with (session_factory or SessionLocal)() as session:
        insert = pg_insert if session.get_bind().dialect.name == "postgresql" else sqlite_insert
        statement = insert(counters).values(key=key, window=window, count=1)
        statement = statement.on_conflict_do_update(
            index_elements=[counters.c.key],
            set_={
                "window": window,
                "count": case((counters.c.window == window, counters.c.count + 1), else_=1),
            },
        ).returning(counters.c.count)
        count = session.scalar(statement)
        session.commit()
    if count > limit:
        raise AppError("RATE_LIMITED", "操作太频繁，请稍后再试。", 429)


def preflight_user(scope, *, session_factory=None) -> str:
    request = Request(scope)
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    credentials = (
        HTTPAuthorizationCredentials(scheme=scheme, credentials=token)
        if scheme.lower() == "bearer" and token
        else None
    )
    with (session_factory or SessionLocal)() as session:
        return current_user(request, credentials, session).id


def preflight_upload(scope) -> None:
    user_id = preflight_user(scope)
    check_limit("upload", user_id)
    scope.setdefault("state", {})["upload_limit_user_id"] = user_id


def limit_upload(request: Request, user: User = Depends(current_user)):
    if getattr(request.state, "upload_limit_user_id", None) != user.id:
        check_limit("upload", user.id)


def limit_messages(user: User = Depends(current_user)):
    check_limit("messages", user.id)


class RequestProtectionMiddleware:
    """Enforce auth limits before parsing and bound streamed multipart bodies."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path in {"/api/auth/register", "/api/auth/login"}:
            try:
                await run_in_threadpool(
                    check_limit, path.rsplit("/", 1)[1], (scope.get("client") or ("unknown",))[0]
                )
            except AppError as exc:
                from starlette.responses import JSONResponse

                return await JSONResponse(
                    {"error": {"code": exc.code, "message": exc.message}},
                    exc.status_code,
                    headers={"Retry-After": str(settings.rate_limit_window_seconds)},
                )(scope, receive, send)
        if path != "/api/assets":
            return await self.app(scope, receive, send)
        try:
            await run_in_threadpool(preflight_upload, scope)
        except AppError as exc:
            from starlette.responses import JSONResponse

            headers = (
                {"Retry-After": str(settings.rate_limit_window_seconds)}
                if exc.status_code == 429
                else None
            )
            return await JSONResponse(
                {"error": {"code": exc.code, "message": exc.message}},
                exc.status_code,
                headers=headers,
            )(scope, receive, send)
        # Multipart framing and fields have a separate, bounded allowance.
        maximum = settings.max_upload_bytes + 64 * 1024
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = 0
        if declared > maximum:
            return await self._too_large(scope, receive, send)
        from tempfile import SpooledTemporaryFile

        body = SpooledTemporaryFile(max_size=1024 * 1024)
        try:
            received = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                received += len(chunk)
                if received > maximum:
                    return await self._too_large(scope, receive, send)
                await run_in_threadpool(body.write, chunk)
                if not message.get("more_body", False):
                    break
            await run_in_threadpool(body.seek, 0)
            replayed = False

            def read_chunk():
                chunk = body.read(64 * 1024)
                return chunk, body.tell() < received

            async def bounded_receive():
                nonlocal replayed
                if replayed:
                    return await receive()
                chunk, more = await run_in_threadpool(read_chunk)
                replayed = not more
                return {"type": "http.request", "body": chunk, "more_body": more}

            return await self.app(scope, bounded_receive, send)
        finally:
            await run_in_threadpool(body.close)

    @staticmethod
    async def _too_large(scope, receive, send):
        from starlette.responses import JSONResponse

        await JSONResponse(
            {"error": {"code": "FILE_TOO_LARGE", "message": "图片不能超过 15MB"}}, 413
        )(scope, receive, send)
