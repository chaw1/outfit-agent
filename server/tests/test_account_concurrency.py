"""PostgreSQL account mutations fence concurrent recovery and worker publication."""

import io
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.postgres import PostgresSaver
from PIL import Image
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from app import account, rate_limits, worker
from app.config import settings
from app.main import app
from app.media import store_upload
from app.models import Asset, Base, Job, Message, Project, User, utcnow
from app.observability import bind_session
from app.providers import GeneratedMedia, ProviderHub
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


def test_deletion_fences_running_worker_and_clears_all_checkpoint_namespaces(
    isolated_database_url, tmp_path, monkeypatch,
):
    engine = create_engine(
        isolated_database_url,
        connect_args={"options": "-c statement_timeout=10000 -c lock_timeout=5000"},
    )
    Base.metadata.create_all(engine)
    rate_limits.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    image_data = output.getvalue()
    started, release = Event(), Event()

    def override_session():
        with factory() as session:
            bind_session(session)
            yield session

    previous_override = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = override_session
    client = TestClient(app)
    database = isolated_database_url.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )
    try:
        password = f"delete-worker-{uuid4().hex}"
        registration = client.post("/api/auth/register", json={
            "username": f"worker10_{uuid4().hex[:16]}", "password": password,
        })
        assert registration.status_code == 200
        registered = registration.json()
        owner_id = registered["user"]["id"]
        client.headers["Authorization"] = "Bearer " + registered["token"]
        with factory() as session:
            other = User(
                username=f"retained10_{uuid4().hex[:16]}", password_hash="unused",
                nickname="其他人",
            )
            session.add(other)
            session.flush()
            upload = store_upload(session, user_id=owner_id, kind="garment", data=image_data)
            retained = store_upload(session, user_id=other.id, kind="garment", data=image_data)
            project = Project(
                user_id=owner_id, title="注销时生成中", brand="本地品牌", brief="在途结果不能复活",
                garment_asset_ids=[upload.id],
            )
            other_project = Project(
                user_id=other.id, title="保留检查点", brand="本地品牌", brief="其他用户的数据",
                garment_asset_ids=[retained.id],
            )
            session.add_all([project, other_project])
            session.flush()
            job = Job(
                user_id=owner_id, project_id=project.id, kind="image", status="running",
                attempts=1, locked_at=utcnow(), dedupe_key=str(uuid4()),
                payload={"prompt": "生成本人衣服图", "reference_asset_ids": [upload.id]},
            )
            session.add_all([
                job, Message(project_id=project.id, role="user", text="请生成一张图"),
            ])
            session.commit()
            project_id, other_project_id, job_id = project.id, other_project.id, job.id
            upload_path = settings.media_dir / upload.path
            retained_path = settings.media_dir / retained.path

        with PostgresSaver.from_conn_string(database) as saver:
            saver.setup()
            namespaces = ("", "subgraph:one", "subgraph:two")
            for thread_id in (project_id, other_project_id):
                for namespace in namespaces:
                    checkpoint = empty_checkpoint()
                    checkpoint["channel_values"] = {"messages": ["private history"]}
                    checkpoint["channel_versions"] = {"messages": "1"}
                    config = saver.put(
                        {"configurable": {"thread_id": thread_id, "checkpoint_ns": namespace}},
                        checkpoint, {"source": "input", "step": 0, "parents": {}},
                        {"messages": "1"},
                    )
                    saver.put_writes(config, [("messages", "pending reply")], "task")

            def delayed_image(self, prompt, assets):
                started.set()
                assert release.wait(timeout=15), "test did not release generation"
                return GeneratedMedia(
                    data=image_data, mime="image/png", model="mock", width=32, height=48,
                )

            monkeypatch.setattr(ProviderHub, "image", delayed_image)
            monkeypatch.setattr(
                ProviderHub, "fidelity", lambda *_args, **_kwargs: {"score": 90, "diffs": []},
            )
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(worker.process_job, job_id, 1, factory)
                try:
                    assert started.wait(timeout=10), "worker did not start generation"
                    response = client.request("DELETE", "/api/me", json={"password": password})
                    assert response.status_code == 204
                finally:
                    release.set()
                future.result(timeout=15)

            assert client.get("/api/me").status_code == 401
            with factory() as session:
                assert session.get(User, owner_id).deleted_at is not None
                assert session.get(Project, project_id).deleted_at is not None
                assert session.get(Project, other_project_id).deleted_at is None
                for model in (Asset, Job):
                    assert session.scalar(
                        select(func.count()).select_from(model).where(model.user_id == owner_id),
                    ) == 0
                assert session.scalar(select(func.count()).select_from(Message).where(
                    Message.project_id == project_id,
                )) == 0
                for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
                    assert session.scalar(
                        text(f"SELECT count(*) FROM {table} WHERE thread_id = :id"),
                        {"id": project_id},
                    ) == 0
                    assert session.scalar(
                        text(f"SELECT count(*) FROM {table} WHERE thread_id = :id"),
                        {"id": other_project_id},
                    ) > 0
            for namespace in namespaces:
                assert saver.get_tuple({"configurable": {
                    "thread_id": project_id, "checkpoint_ns": namespace,
                }}) is None
                assert saver.get_tuple({"configurable": {
                    "thread_id": other_project_id, "checkpoint_ns": namespace,
                }}) is not None
        assert not upload_path.exists()
        assert retained_path.read_bytes() == image_data
        assert list(settings.media_dir.iterdir()) == [retained_path]
    finally:
        release.set()
        client.close()
        if previous_override is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous_override
        engine.dispose()
