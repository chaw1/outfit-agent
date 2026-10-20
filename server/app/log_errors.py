"""Tracebacks without credentials, including exception chains and source frames."""

import json
import logging
import re
import traceback
from urllib.parse import quote, quote_plus, urlsplit, urlunsplit

from sqlalchemy.engine import make_url

from app.config import settings


def redact_text(detail: str) -> str:
    secrets = [
        settings.dashscope_api_key, settings.deepseek_api_key,
        settings.jwt_secret, settings.admin_token,
    ]
    password = make_url(settings.database_url).password
    if password:
        secrets.append(password)
    representations = {
        value
        for secret in secrets
        if secret
        for value in (
            secret,
            quote(secret, safe=""),
            quote_plus(secret),
            json.dumps(secret)[1:-1],
            repr(secret)[1:-1],
        )
    }
    for secret in sorted(representations, key=len, reverse=True):
        if secret:
            detail = detail.replace(secret, "[REDACTED]")
    detail = re.sub(r"(?i)Bearer\s+[^\s'\"\\]+", "Bearer [REDACTED]", detail)
    # Provider failures sometimes contain signed asset URLs or URL credentials.
    def safe_url(match):
        try:
            url = urlsplit(match.group())
            host = url.hostname or ""
            if ":" in host:
                host = f"[{host}]"
            if url.port:
                host += f":{url.port}"
            return urlunsplit((url.scheme, host, url.path, "", ""))
        except ValueError:
            return "[REDACTED_URL]"

    detail = re.sub(r"https?://[^\s'\"<>\\]+", safe_url, detail)
    detail = re.sub(
        r"(?i)\b(password(?:_hash)?|passwd|(?:access_|refresh_)?token|secret|"
        r"client_secret|api[_-]?key|authorization)\b([\"']?\s*[:=]\s*)"
        r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)",
        r"\1\2[REDACTED]", detail,
    )
    return detail


def log_exception(logger: logging.Logger, message: str, exc: BaseException) -> None:
    detail = redact_text("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    # Import lazily: observability also uses the redactor for all event fields.
    from app.observability import structured_log
    structured_log(
        "exception", level=logging.ERROR, target_logger=logger, message=message,
        error_type=type(exc).__name__, detail=detail, logger=logger.name,
    )
