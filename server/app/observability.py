"""Credential-free request/model events and persistent operational counters."""

import asyncio
import json
import logging
import re
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Table, func, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from app.log_errors import redact_text
from app.models import Base, utcnow

request_events = Table(
    "request_events", Base.metadata,
    Column("id", String(36), primary_key=True),
    Column("request_id", String(128), nullable=False),
    Column("user_id", String(128), nullable=True),
    Column("project_id", String(128), nullable=True),
    Column("method", String(16), nullable=False),
    Column("route", String(200), nullable=False),
    Column("duration_ms", Integer, nullable=False),
    Column("status_code", Integer, nullable=False),
    Column("is_error", Boolean, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_request_events_created_at", "created_at"),
)

# A dedicated handler keeps each event a single JSON line under Uvicorn and workers.
logger = logging.getLogger("outfit.events")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)


@dataclass
class RequestContext:
    request_id: str
    user_id: str | None = None
    project_id: str | None = None
    bind: Engine | Connection | None = None
    is_error: bool = False


# The shared object survives context copies made by AnyIO and asyncio.to_thread.
_context: ContextVar[RequestContext | None] = ContextVar("outfit_request", default=None)


def bind_session(session: Session) -> None:
    context = _context.get()
    if context is not None:
        context.bind = session.get_bind()


def bind_user(request, user_id: str, session: Session) -> None:
    context = _context.get()
    if context is not None:
        context.user_id = str(user_id)[:128]
        bind_project(request.path_params.get("project_id"))
        bind_session(session)
        request.state.request_id = context.request_id
        request.state.user_id = context.user_id


def bind_project(project_id: str | None) -> None:
    context = _context.get()
    if context is not None and project_id is not None:
        context.project_id = str(project_id)[:128]


def mark_request_error() -> None:
    context = _context.get()
    if context is not None:
        context.is_error = True


def structured_log(event: str, *, level: int = logging.INFO,
                   target_logger: logging.Logger | None = None, **fields) -> None:
    context = _context.get()
    payload = {
        "event": event,
        "request_id": context.request_id if context else None,
        "user_id": context.user_id if context else None,
        "project_id": context.project_id if context else None,
        **fields,
    }
    payload = {key: redact_text(value) if isinstance(value, str) else value
               for key, value in payload.items()}
    (target_logger or logger).log(level, json.dumps(payload, ensure_ascii=False, default=str))


def log_model(*, model: str, duration_ms: int, cost_cny, user_id: str | None = None,
              project_id: str | None = None, status: str = "succeeded") -> None:
    fields = {
        "model": model, "duration_ms": duration_ms,
        "cost_cny": float(cost_cny), "status": status,
    }
    if user_id is not None:
        fields["user_id"] = user_id
    if project_id is not None:
        fields["project_id"] = project_id
    structured_log("model_call", **fields)


def request_totals(session: Session) -> dict[str, int]:
    """Completed requests in a rolling UTC 24h; HTTP >=400 or SSE error count once."""
    now = utcnow()
    requests, errors = session.execute(select(
        func.count(), func.count().filter(request_events.c.is_error.is_(True)),
    ).select_from(request_events).where(
        request_events.c.created_at >= now - timedelta(hours=24),
        request_events.c.created_at <= now,
    )).one()
    return {"requests_24h": requests or 0, "errors_24h": errors or 0}


def _persist(context: RequestContext, session_factory, values: dict) -> None:
    try:
        if context.bind is not None:
            with Session(context.bind) as session:
                session.execute(request_events.insert().values(**values))
                session.commit()
        elif session_factory is not None:
            with session_factory() as session:
                session.execute(request_events.insert().values(**values))
                session.commit()
    except Exception as exc:
        # Telemetry failure must never replace the user's successful response.
        structured_log("request_persistence_failed", level=logging.ERROR,
                       error_type=type(exc).__name__)


class RequestObservabilityMiddleware:
    """Pure ASGI wrapper: IDs cover errors and streams, timings cover the full body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        incoming = next((value for name, value in scope.get("headers", [])
                         if name.lower() == b"x-request-id"), b"")
        # Accept ordinary opaque IDs; reject oversized/control headers before echoing.
        request_id = incoming.decode("latin-1")
        if not re.fullmatch(r"[\x20-\x7e]{1,128}", request_id):
            request_id = uuid4().hex
        context = RequestContext(request_id=request_id)
        token = _context.set(context)
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.monotonic()
        status_code = 500
        response_started = False
        response_complete = False
        is_sse = False
        pending_line = b""

        async def observed_send(message):
            nonlocal status_code, response_started, response_complete, is_sse, pending_line
            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_started = True
                headers = [(name, value) for name, value in message.get("headers", [])
                           if name.lower() != b"x-request-id"]
                headers.append((b"x-request-id", request_id.encode("ascii")))
                is_sse = any(name.lower() == b"content-type" and
                             value.startswith(b"text/event-stream") for name, value in headers)
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and is_sse:
                # Only inspect the bounded event line, never log or retain SSE data.
                parts = message.get("body", b"").split(b"\n")
                for part in parts[:-1]:
                    line = (pending_line + part[:128]).strip()
                    if line.startswith(b"event:") and line[6:].strip() == b"error":
                        context.is_error = True
                    pending_line = b""
                pending_line = (pending_line + parts[-1])[:128]
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                response_complete = True

        try:
            await self.app(scope, receive, observed_send)
        except Exception as exc:
            context.is_error = True
            from app.log_errors import log_exception
            log_exception(logger, "Request failed", exc)
            if response_started:
                # Re-raising after headers lets Uvicorn log the original, unredacted exception.
                # Close a broken stream once; completed responses need no extra ASGI message.
                if not response_complete:
                    body = b""
                    if is_sse:
                        error = {"code": "INTERNAL_ERROR", "message": "服务暂时不可用，请稍后重试"}
                        body = ("event: error\ndata: " + json.dumps(error, ensure_ascii=False)
                                + "\n\n").encode()
                    try:
                        await observed_send({"type": "http.response.body", "body": body,
                                             "more_body": False})
                    except Exception:
                        # A disconnected transport cannot receive the final error event.
                        pass
                return
            response = JSONResponse(
                {"error": {"code": "INTERNAL_ERROR", "message": "服务暂时不可用，请稍后重试"}}, 500
            )
            await response(scope, receive, observed_send)
        finally:
            try:
                bind_project(scope.get("path_params", {}).get("project_id"))
                duration_ms = round((time.monotonic() - started) * 1000)
                route = getattr(scope.get("route"), "path", "<unmatched>")
                fields = {
                    "method": scope["method"], "route": route,
                    "duration_ms": duration_ms, "status_code": status_code,
                    "is_error": context.is_error or status_code >= 400,
                }
                structured_log("http_request", **fields)
                application = scope.get("app")
                factory = getattr(getattr(application, "state", None),
                                  "observability_session_factory", None)
                values = {
                    "id": str(uuid4()), "request_id": redact_text(request_id),
                    "user_id": redact_text(context.user_id) if context.user_id else None,
                    "project_id": redact_text(context.project_id) if context.project_id else None,
                    "created_at": utcnow(), **fields,
                }
                await asyncio.to_thread(_persist, context, factory, values)
            finally:
                _context.reset(token)
