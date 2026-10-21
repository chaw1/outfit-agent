"""Recovery codes are consumed once even when PostgreSQL requests race."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import account, rate_limits
from app.main import app
from app.models import Base, User
from app.observability import bind_session
from app.security import get_session, verify_password

pytestmark = pytest.mark.integration


def test_recovery_code_is_consumed_once_by_concurrent_requests(
    isolated_database_url, monkeypatch,
):
    engine = create_engine(
        isolated_database_url,
        connect_args={"options": "-c statement_timeout=10000 -c lock_timeout=5000"},
    )
    Base.metadata.create_all(engine)
    rate_limits.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)

    def override_session():
        with factory() as session:
            bind_session(session)
            yield session

    previous_override = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = override_session
    client = TestClient(app)  # Deliberately avoid lifespan and its shared database setup.
    try:
        username = f"race10_{uuid4().hex[:16]}"
        initial_password = f"initial-{uuid4().hex}"
        registration = client.post("/api/auth/register", json={
            "username": username, "password": initial_password,
            "agreed_legal_version": "2026-10-21",
        })
        assert registration.status_code == 200
        registered = registration.json()
        original_code = registered["recovery_code"]
        barrier = Barrier(2)
        original_check_limit = account.check_limit

        def synchronized_check_limit(category, subject, **kwargs):
            original_check_limit(category, subject, **kwargs)
            if category == "recover" and subject == username:
                barrier.wait(timeout=10)

        monkeypatch.setattr(account, "check_limit", synchronized_check_limit)

        def recover(index):
            # Both requests consume the same code; distinct passwords reveal the winner.
            password = f"concurrent-{index}-{uuid4().hex}"
            response = client.post("/api/auth/recover", json={
                "username": username, "recovery_code": original_code,
                "new_password": password,
            })
            return password, response

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(recover, range(2)))
        assert sorted(response.status_code for _, response in results) == [200, 401]
        winning_password, successful = next(
            result for result in results if result[1].status_code == 200
        )
        losing_password, rejected = next(
            result for result in results if result[1].status_code == 401
        )
        assert rejected.json()["error"]["code"] == "RECOVERY_FAILED"
        recovered = successful.json()
        assert recovered["user"]["id"] == registered["user"]["id"]
        assert recovered["recovery_code"] != original_code
        assert client.get("/api/me", headers={
            "Authorization": "Bearer " + registered["token"],
        }).status_code == 401
        current = client.get("/api/me", headers={
            "Authorization": "Bearer " + recovered["token"],
        })
        assert current.status_code == 200
        assert current.json()["id"] == registered["user"]["id"]

        with factory() as session:
            user = session.get(User, registered["user"]["id"])
            assert user is not None and user.password_updated_at is not None
            assert verify_password(winning_password, user.password_hash)
            assert not verify_password(losing_password, user.password_hash)
            assert not verify_password(initial_password, user.password_hash)
            assert verify_password(
                recovered["recovery_code"].replace("-", ""), user.recovery_code_hash,
            )
            assert not verify_password(original_code.replace("-", ""), user.recovery_code_hash)
            assert recovered["recovery_code"] not in repr(user.__dict__)
    finally:
        client.close()
        if previous_override is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous_override
        engine.dispose()
