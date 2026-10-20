import io
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import main, rate_limits
from app.config import settings
from app.errors import AppError
from app.media import inspect_image, store_upload
from app.models import Base, User
from app.security import current_user


@pytest.fixture
def limiter(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'limits.sqlite'}")
    rate_limits.metadata.create_all(engine)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)
    monkeypatch.setattr(settings, "rate_limit_register", 2)
    monkeypatch.setattr(settings, "rate_limit_login", 2)
    monkeypatch.setattr(settings, "rate_limit_upload", 2)
    monkeypatch.setattr(settings, "rate_limit_messages", 2)
    yield factory
    engine.dispose()


def test_limits_are_atomic_across_connections_and_reset_next_window(limiter):
    def attempt(_):
        try:
            rate_limits.check_limit("messages", "one-user", now=120)
            return True
        except AppError as exc:
            assert exc.status_code == 429 and "稍后" in exc.message
            return False

    with ThreadPoolExecutor(max_workers=6) as executor:
        assert sum(executor.map(attempt, range(12))) == 2
    rate_limits.check_limit("messages", "another-user", now=120)
    rate_limits.check_limit("upload", "one-user", now=120)
    rate_limits.check_limit("messages", "one-user", now=180)
    with limiter() as session:
        assert (
            session.scalar(
                select(rate_limits.counters.c.count)
                .where(rate_limits.counters.c.key.like("messages:%"))
                .order_by(rate_limits.counters.c.count.desc())
            )
            == 1
        )


def protection_app(monkeypatch):
    monkeypatch.setattr(
        rate_limits, "preflight_user", lambda scope: Request(scope).headers["authorization"]
    )
    app = FastAPI()
    app.add_middleware(rate_limits.RequestProtectionMiddleware)
    app.add_exception_handler(AppError, main.app_error_handler)

    @app.post("/api/auth/register")
    @app.post("/api/auth/login")
    def auth():
        raise AppError("INVALID_CREDENTIALS", "用户名或密码错误", 401)

    @app.post("/api/assets", dependencies=[Depends(rate_limits.limit_upload)])
    @app.post("/api/projects/test/messages", dependencies=[Depends(rate_limits.limit_messages)])
    def authenticated():
        return {"ok": True}

    def user(request: Request):
        return SimpleNamespace(id=request.headers["authorization"])

    app.dependency_overrides[current_user] = user
    return app


def test_auth_attempts_limit_by_peer_ip_and_ignore_forwarded_spoofing(limiter, monkeypatch):
    app = protection_app(monkeypatch)
    with TestClient(app, client=("192.0.2.1", 10)) as client:
        for forwarded in ("192.0.2.2", "192.0.2.3"):
            assert (
                client.post(
                    "/api/auth/login",
                    headers={
                        "X-Forwarded-For": forwarded,
                    },
                ).status_code
                == 401
            )
        response = client.post("/api/auth/login")
        assert response.status_code == 429
        assert response.json()["error"]["message"] == "操作太频繁，请稍后再试。"
        assert response.headers["retry-after"] == "60"
        assert client.post("/api/auth/register").status_code == 401
    with TestClient(app, client=("192.0.2.9", 10)) as other:
        assert other.post("/api/auth/login").status_code == 401


@pytest.mark.parametrize("path", ["/api/assets", "/api/projects/test/messages"])
def test_upload_and_dialogue_limit_by_user(limiter, path, monkeypatch):
    with TestClient(protection_app(monkeypatch)) as client:
        for _ in range(2):
            assert client.post(path, headers={"Authorization": "user-one"}).status_code == 200
        assert client.post(path, headers={"Authorization": "user-one"}).status_code == 429
        assert client.post(path, headers={"Authorization": "user-two"}).status_code == 200


def test_body_limit_rejects_declared_and_chunked_uploads_before_parser(limiter, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 64)
    with TestClient(protection_app(monkeypatch)) as client:
        headers = {"Authorization": "user", "Content-Length": "70000"}
        assert client.post("/api/assets", headers=headers, content=b"x").status_code == 413
        response = client.post(
            "/api/assets",
            headers={"Authorization": "user"},
            content=(chunk for chunk in (b"x" * 40000, b"x" * 40000)),
        )
        assert response.status_code == 413


def encoded(format="PNG", size=(32, 24)):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, format)
    return output.getvalue()


@pytest.mark.parametrize("format", ["JPEG", "PNG", "WEBP", "HEIF"])
def test_supported_upload_formats_are_decoded_from_content(format):
    width, height, mime = inspect_image(encoded(format), upload=True)
    assert (width, height) == (32, 24) and mime.startswith("image/")


@pytest.mark.parametrize("data", [b"invalid", encoded("GIF"), encoded("JPEG")[:100]])
def test_invalid_or_disallowed_content_returns_415(data):
    with pytest.raises(AppError) as error:
        inspect_image(data, upload=True)
    assert error.value.status_code == 415


def test_edge_limit_accepts_6000_and_rejects_6001():
    assert inspect_image(encoded(size=(6000, 1)), upload=True)[:2] == (6000, 1)
    with pytest.raises(AppError) as error:
        inspect_image(encoded(size=(6001, 1)), upload=True)
    assert error.value.status_code == 413 and "6000" in error.value.message


def test_heic_is_normalized_and_size_checked_before_persist(limiter, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    with limiter() as session:
        user = User(username="heic-user", nickname="HEIC", password_hash="unused")
        session.add(user)
        session.flush()
        asset = store_upload(session, user_id=user.id, kind="model", data=encoded("HEIF"))
        assert asset.mime == "image/jpeg" and asset.path.endswith(".jpg")
        assert (settings.media_dir / asset.path).is_file()
        monkeypatch.setattr(settings, "max_upload_bytes", 10)
        with pytest.raises(AppError) as error:
            store_upload(session, user_id=user.id, kind="garment", data=encoded())
        assert error.value.status_code == 413


def test_chunked_upload_spool_uses_threads_for_disk_io(limiter, monkeypatch):
    monkeypatch.setattr(rate_limits, "preflight_user", lambda scope: "stream-user")
    import asyncio
    import tempfile
    import threading

    event_loop_thread = threading.get_ident()
    operations = []
    rolled = []
    original_spool = tempfile.SpooledTemporaryFile

    def tracked_spool(*args, **kwargs):
        spool = original_spool(*args, **kwargs)
        proxy = SimpleNamespace()
        for name in ("write", "seek", "read", "tell", "close"):

            def tracked(*args, method=name, **kwargs):
                operations.append((method, threading.get_ident()))
                if method == "close":
                    rolled.append(spool._rolled)
                return getattr(spool, method)(*args, **kwargs)

            setattr(proxy, name, tracked)
        return proxy

    monkeypatch.setattr(tempfile, "SpooledTemporaryFile", tracked_spool)
    chunks = [b"x" * 700_000] * 3
    downstream_bytes = []

    async def receive():
        body = chunks.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(chunks)}

    async def downstream(scope, receive, send):
        while True:
            message = await receive()
            downstream_bytes.append(len(message["body"]))
            if not message["more_body"]:
                break

    async def send(message):
        raise AssertionError("valid upload must reach downstream")

    middleware = rate_limits.RequestProtectionMiddleware(downstream)
    asyncio.run(
        middleware(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/assets",
                "headers": [],
            },
            receive,
            send,
        )
    )
    assert sum(downstream_bytes) == 2_100_000
    assert rolled == [True]
    assert {name for name, _ in operations} == {"write", "seek", "read", "tell", "close"}
    assert all(thread_id != event_loop_thread for _, thread_id in operations)


def test_upload_auth_and_limit_rejection_do_not_read_request_stream(limiter):
    import asyncio

    from app.security import issue_token

    with limiter() as session:
        enabled = User(username="enabled", nickname="可用", password_hash="unused")
        disabled = User(username="disabled", nickname="禁用", password_hash="unused", disabled=True)
        session.add_all([enabled, disabled])
        session.commit()
        enabled_token = issue_token(enabled.id)
        disabled_token = issue_token(disabled.id)
        rate_limits.check_limit("upload", enabled.id)
        rate_limits.check_limit("upload", enabled.id)

    async def should_not_receive():
        raise AssertionError("rejected upload read its body")

    async def should_not_run(*args):
        raise AssertionError("rejected upload reached parser")

    middleware = rate_limits.RequestProtectionMiddleware(should_not_run)
    for authorization, expected_status in (
        (None, 401),
        ("Bearer invalid", 401),
        ("Bearer " + disabled_token, 403),
        ("Bearer " + enabled_token, 429),
    ):
        responses = []

        async def send(message, target=responses):
            target.append(message)

        headers = [(b"authorization", authorization.encode())] if authorization else []
        asyncio.run(
            middleware(
                {
                    "type": "http",
                    "method": "POST",
                    "path": "/api/assets",
                    "headers": headers,
                },
                should_not_receive,
                send,
            )
        )
        assert responses[0]["status"] == expected_status
        assert any("请" in message.get("body", b"").decode() for message in responses[1:])


@pytest.mark.integration
def test_postgres_limit_is_shared_atomically_by_independent_api_instances(
    isolated_database_url,
    monkeypatch,
):
    import threading

    engines = [create_engine(isolated_database_url) for _ in range(2)]
    factories = [sessionmaker(engine) for engine in engines]
    monkeypatch.setattr(settings, "rate_limit_messages", 3)
    monkeypatch.setattr(settings, "rate_limit_window_seconds", 60)
    concurrent_start = threading.Barrier(16)
    try:
        rate_limits.metadata.create_all(engines[0])

        def attempt(index):
            concurrent_start.wait(timeout=10)
            try:
                rate_limits.check_limit(
                    "messages",
                    "shared-user",
                    session_factory=factories[index % 2],
                    now=120,
                )
                return 200
            except AppError as error:
                assert error.code == "RATE_LIMITED" and "稍后" in error.message
                return error.status_code

        with ThreadPoolExecutor(max_workers=16) as executor:
            statuses = list(executor.map(attempt, range(16)))
        assert statuses.count(200) == 3
        assert statuses.count(429) == 13
        rate_limits.check_limit(
            "messages",
            "another-user",
            session_factory=factories[1],
            now=120,
        )
        rate_limits.check_limit(
            "messages",
            "shared-user",
            session_factory=factories[0],
            now=180,
        )
        rate_limits.check_limit(
            "messages",
            "shared-user",
            session_factory=factories[1],
            now=180,
        )
    finally:
        for engine in engines:
            engine.dispose()
