"""Tracebacks without credentials, including exception chains and source frames."""

import json
import logging
import re
import traceback
from urllib.parse import quote, quote_plus

from sqlalchemy.engine import make_url

from app.config import settings


def log_exception(logger: logging.Logger, message: str, exc: BaseException) -> None:
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    secrets = [settings.dashscope_api_key, settings.deepseek_api_key, settings.jwt_secret]
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
    logger.exception("%s\n%s", message, detail, exc_info=False)
