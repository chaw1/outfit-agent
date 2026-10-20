import io
import threading
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.postgres import PostgresSaver
from PIL import Image
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.orm import sessionmaker

from app import worker
from app.config import settings
from app.media import store_generated
from app.models import AppSetting, Asset, Base, Job, Message, Project, UsageLedger, User, utcnow
from app.project_cleanup import CLEANUP_PREFIX, cleanup_project, drain_media_cleanup
from app.providers import GeneratedMedia, ProviderHub


def media():
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    return GeneratedMedia(
        data=output.getvalue(), mime="image/png", model="mock", width=32, height=48
    )


def seed(factory):
    with factory() as session:
        owner = User(username=f"owner_{uuid4().hex[:16]}", password_hash="unused", nickname="本人")
        other = User(
            username=f"other_{uuid4().hex[:16]}", password_hash="unused", nickname="其他人"
        )
        session.add_all([owner, other])
        session.flush()
        upload = Asset(
            user_id=owner.id,
            kind="garment",
            source="upload",
            path="upload.png",
            mime="image/png",
            width=32,
            height=48,
        )
        foreign = Asset(
            user_id=other.id,
            kind="garment",
            source="upload",
            path="other.png",
            mime="image/png",
            width=32,
            height=48,
        )
        session.add_all([upload, foreign])
        session.flush()
        projects = [
            Project(
                user_id=owner.id,
                title="清理项目",
                brand="测试",
                brief="测试",
                garment_asset_ids=[upload.id],
            ),
            Project(
                user_id=owner.id,
                title="复用原图",
                brand="测试",
                brief="测试",
                garment_asset_ids=[upload.id],
            ),
            Project(
                user_id=other.id,
                title="其他用户",
                brand="测试",
                brief="测试",
                garment_asset_ids=[foreign.id],
            ),
        ]
        session.add_all(projects)
        session.flush()
        for project in projects:
            session.add(Message(project_id=project.id, role="assistant", text="保留或删除"))
        session.add(
            UsageLedger(
                project_id=projects[0].id,
                user_id=owner.id,
                model="mock",
                kind="image",
                estimated_cny=Decimal("0.01"),
            )
        )
        session.commit()
        return owner.id, [project.id for project in projects], upload.id, foreign.id


@pytest.fixture
def cleanup_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'cleanup.sqlite'}")

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    for name in ("upload.png", "other.png"):
        (settings.media_dir / name).write_bytes(media().data)
    yield factory, seed(factory)
    engine.dispose()


def test_cascade_cleans_generated_versions_but_preserves_uploads_and_other_users(cleanup_db):
    factory, (owner_id, project_ids, upload_id, foreign_id) = cleanup_db
    project_id, reused_id, other_id = project_ids
    with factory() as session:
        first = store_generated(
            session, user_id=owner_id, project_id=project_id, kind="reference", media=media()
        )
        second = store_generated(
            session,
            user_id=owner_id,
            project_id=project_id,
            kind="reference",
            media=media(),
            parent_id=first.id,
        )
        # A retained child must not keep the deleted version alive through its FK.
        retained = Asset(
            user_id=owner_id,
            project_id=reused_id,
            kind="reference",
            path="retained.png",
            mime="image/png",
            source="generated",
            parent_id=second.id,
        )
        session.add(retained)
        session.add(
            Job(
                user_id=owner_id,
                project_id=project_id,
                kind="image",
                status="succeeded",
                result_asset_id=second.id,
                dedupe_key=str(uuid4()),
            )
        )
        session.commit()
        paths = [settings.media_dir / first.path, settings.media_dir / second.path]
        retained_id = retained.id
    with factory() as session:
        cleanup_project(session, session.get(Project, project_id))
    with factory() as session:
        assert session.get(Project, project_id).deleted_at is not None
        assert session.scalars(select(Message).where(Message.project_id == project_id)).all() == []
        assert session.scalars(select(Job).where(Job.project_id == project_id)).all() == []
        assert session.scalars(select(Asset).where(Asset.project_id == project_id)).all() == []
        assert session.get(Asset, upload_id) and session.get(Asset, foreign_id)
        assert session.get(Asset, retained_id).parent_id is None
        assert session.get(Project, reused_id).garment_asset_ids == [upload_id]
        assert session.scalar(select(func.count()).select_from(Message)) == 2
        assert session.scalar(select(func.count()).select_from(UsageLedger)) == 1
        assert session.get(Project, other_id).deleted_at is None
        assert session.get(AppSetting, CLEANUP_PREFIX + project_id) is None
    assert all(not path.exists() for path in paths)
    assert (settings.media_dir / "upload.png").exists()
    assert (settings.media_dir / "other.png").exists()


def test_failed_delete_transaction_keeps_original_files_and_rows(cleanup_db, monkeypatch):
    factory, (owner_id, project_ids, _, _) = cleanup_db
    project_id = project_ids[0]
    with factory() as session:
        asset = store_generated(
            session, user_id=owner_id, project_id=project_id, kind="reference", media=media()
        )
        session.commit()
        path, asset_id = settings.media_dir / asset.path, asset.id
    with factory() as session:

        def fail_commit():
            raise RuntimeError("commit rejected")

        monkeypatch.setattr(session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="commit rejected"):
            cleanup_project(session, session.get(Project, project_id))
        session.rollback()
    with factory() as session:
        assert session.get(Project, project_id).deleted_at is None
        assert session.get(Asset, asset_id) is not None
        assert session.get(AppSetting, CLEANUP_PREFIX + project_id) is None
    assert path.exists()


def test_generated_file_is_removed_on_rollback_and_session_close(cleanup_db):
    factory, (owner_id, project_ids, _, _) = cleanup_db
    for explicit_rollback in (True, False):
        with factory() as session:
            asset = store_generated(
                session,
                user_id=owner_id,
                project_id=project_ids[0],
                kind="reference",
                media=media(),
            )
            path = settings.media_dir / asset.path
            assert path.exists()
            if explicit_rollback:
                session.rollback()
        assert not path.exists()


def test_file_cleanup_retries_and_never_deletes_outside_media_or_shared_upload(
    cleanup_db,
    tmp_path,
    monkeypatch,
):
    factory, (owner_id, project_ids, _, _) = cleanup_db
    project_id = project_ids[0]
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"retained")
    with factory() as session:
        generated = store_generated(
            session, user_id=owner_id, project_id=project_id, kind="reference", media=media()
        )
        relative = generated.path
        session.add_all(
            [
                Asset(
                    user_id=owner_id,
                    project_id=project_id,
                    kind="reference",
                    source="generated",
                    mime="image/png",
                    path="../outside.png",
                ),
                Asset(
                    user_id=owner_id,
                    project_id=project_id,
                    kind="reference",
                    source="generated",
                    mime="image/png",
                    path="upload.png",
                ),
            ]
        )
        session.commit()
    original_unlink = Path.unlink

    def fail_one(path, *args, **kwargs):
        if path.name == relative:
            raise PermissionError("temporary lock")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_one)
    with factory() as session:
        cleanup_project(session, session.get(Project, project_id))
        assert session.get(AppSetting, CLEANUP_PREFIX + project_id).value["paths"] == [relative]
    assert outside.read_bytes() == b"retained"
    assert (settings.media_dir / "upload.png").exists()
    monkeypatch.setattr(Path, "unlink", original_unlink)
    with factory() as session:
        drain_media_cleanup(session)
        assert session.get(AppSetting, CLEANUP_PREFIX + project_id) is None
    assert not (settings.media_dir / relative).exists()


@pytest.mark.integration
def test_running_worker_cannot_publish_after_delete_and_all_thread_namespaces_are_cleared(
    isolated_database_url,
    tmp_path,
    monkeypatch,
):
    engine = create_engine(isolated_database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    (settings.media_dir / "upload.png").write_bytes(media().data)
    (settings.media_dir / "other.png").write_bytes(media().data)
    owner_id, project_ids, upload_id, _ = seed(factory)
    project_id = project_ids[0]
    database = isolated_database_url.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )
    started, release = threading.Event(), threading.Event()
    try:
        with PostgresSaver.from_conn_string(database) as saver:
            saver.setup()
            for thread_id in (project_id, project_ids[2]):
                for namespace in ("", "subgraph:test"):
                    checkpoint = empty_checkpoint()
                    checkpoint["channel_values"] = {"messages": ["private history"]}
                    checkpoint["channel_versions"] = {"messages": "1"}
                    config = saver.put(
                        {"configurable": {"thread_id": thread_id, "checkpoint_ns": namespace}},
                        checkpoint,
                        {"source": "input", "step": 0, "parents": {}},
                        {"messages": "1"},
                    )
                    saver.put_writes(config, [("messages", "pending reply")], "task")
            with factory() as session:
                job = Job(
                    user_id=owner_id,
                    project_id=project_id,
                    kind="image",
                    status="running",
                    attempts=1,
                    locked_at=utcnow(),
                    dedupe_key=str(uuid4()),
                    payload={"prompt": "测试", "reference_asset_ids": [upload_id]},
                )
                session.add(job)
                session.commit()
                job_id = job.id

            def delayed_image(self, prompt, assets):
                started.set()
                assert release.wait(timeout=15), "test did not release generation"
                return media()

            monkeypatch.setattr(ProviderHub, "image", delayed_image)
            monkeypatch.setattr(ProviderHub, "fidelity", lambda *_: {"score": 90, "diffs": []})
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(worker.process_job, job_id, 1, factory)
                try:
                    assert started.wait(timeout=10), "worker did not start external generation"
                    with factory() as session:
                        cleanup_project(session, session.get(Project, project_id))
                finally:
                    release.set()
                future.result(timeout=15)
            with factory() as session:
                assert session.get(Job, job_id) is None
                assert (
                    session.scalar(
                        select(func.count())
                        .select_from(Asset)
                        .where(
                            Asset.project_id == project_id,
                        )
                    )
                    == 0
                )
                assert (
                    session.scalar(
                        select(func.count())
                        .select_from(Message)
                        .where(
                            Message.project_id == project_id,
                        )
                    )
                    == 0
                )
                assert session.get(Project, project_id).deleted_at
                assert session.scalar(select(func.count()).select_from(UsageLedger)) == 1
                for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
                    assert (
                        session.scalar(
                            text(f"SELECT count(*) FROM {table} WHERE thread_id = :id"),
                            {"id": project_id},
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(f"SELECT count(*) FROM {table} WHERE thread_id = :id"),
                            {"id": project_ids[2]},
                        )
                        > 0
                    )
            assert saver.get_tuple({"configurable": {"thread_id": project_id}}) is None
            assert sorted(path.name for path in settings.media_dir.iterdir()) == [
                "other.png",
                "upload.png",
            ]
    finally:
        release.set()
        engine.dispose()


@pytest.mark.integration
def test_deletion_waits_for_publication_then_removes_the_committed_file(
    isolated_database_url,
    tmp_path,
    monkeypatch,
):
    engine = create_engine(isolated_database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    (settings.media_dir / "upload.png").write_bytes(media().data)
    owner_id, project_ids, upload_id, _ = seed(factory)
    project_id = project_ids[0]
    database = isolated_database_url.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )
    publishing, release, deleting, deleted = (threading.Event() for _ in range(4))
    original_store = worker.store_generated
    try:
        with PostgresSaver.from_conn_string(database) as saver:
            saver.setup()
        with factory() as session:
            job = Job(
                user_id=owner_id,
                project_id=project_id,
                kind="image",
                status="running",
                attempts=1,
                locked_at=utcnow(),
                dedupe_key=str(uuid4()),
                payload={"prompt": "测试", "reference_asset_ids": [upload_id]},
            )
            session.add(job)
            session.commit()
            job_id = job.id

        def paused_store(*args, **kwargs):
            asset = original_store(*args, **kwargs)
            publishing.set()
            assert release.wait(timeout=15), "test did not release publication"
            return asset

        def delete_while_publishing():
            with factory() as session:
                project = session.get(Project, project_id)
                deleting.set()
                cleanup_project(session, project)
            deleted.set()

        monkeypatch.setattr(worker, "store_generated", paused_store)
        monkeypatch.setattr(ProviderHub, "image", lambda *_: media())
        monkeypatch.setattr(ProviderHub, "fidelity", lambda *_: {"score": 90, "diffs": []})
        with ThreadPoolExecutor(max_workers=2) as pool:
            generation = pool.submit(worker.process_job, job_id, 1, factory)
            try:
                assert publishing.wait(timeout=10)
                deletion = pool.submit(delete_while_publishing)
                assert deleting.wait(timeout=5)
                assert not deleted.wait(timeout=0.15), "deletion bypassed publication lock"
            finally:
                release.set()
            generation.result(timeout=15)
            deletion.result(timeout=15)
        with factory() as session:
            assert session.get(Job, job_id) is None
            assert (
                session.scalar(
                    select(func.count())
                    .select_from(Asset)
                    .where(
                        Asset.project_id == project_id,
                    )
                )
                == 0
            )
            assert (
                session.scalar(
                    select(func.count())
                    .select_from(Message)
                    .where(
                        Message.project_id == project_id,
                    )
                )
                == 0
            )
            assert session.get(Project, project_id).deleted_at
        assert list(settings.media_dir.iterdir()) == [settings.media_dir / "upload.png"]
    finally:
        release.set()
        engine.dispose()
