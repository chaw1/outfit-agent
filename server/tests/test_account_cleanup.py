"""Account deletion is atomic and its committed file cleanup can be retried."""

import re
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app import account, rate_limits
from app.config import settings
from app.main import app
from app.media import signed_url
from app.models import AppSetting, Asset, Base, Job, Message, Project, UsageLedger, User
from app.observability import bind_session
from app.project_cleanup import CLEANUP_PREFIX, drain_media_cleanup
from app.security import get_session

BUSINESS_MODELS = (User, Project, Asset, Message, Job, UsageLedger, AppSetting)


def _rows(session, model):
    primary_key = next(iter(model.__table__.primary_key.columns))
    return [
        {column.name: getattr(row, column.name) for column in model.__table__.columns}
        for row in session.scalars(select(model).order_by(primary_key))
    ]


def _snapshot(factory):
    with factory() as session:
        return {model: _rows(session, model) for model in BUSINESS_MODELS}


def _register(client, prefix):
    credentials = {
        "username": f"{prefix}_{uuid4().hex[:16]}", "password": f"password-{uuid4().hex}",
    }
    response = client.post("/api/auth/register", json=credentials)
    assert response.status_code == 200
    return credentials, response.json()


def _seed(client, factory):
    credentials, registered = _register(client, "delete10")
    _, other = _register(client, "retain10")
    owner_id, other_id = registered["user"]["id"], other["user"]["id"]
    paths = {owner_id: [], other_id: []}
    other_ids = {model: set() for model in BUSINESS_MODELS if model is not AppSetting}
    other_ids[User].add(other_id)

    def asset(session, user_id, kind, *, source="upload", project_id=None, parent_id=None):
        relative = f"{uuid4().hex}.png"
        path = settings.media_dir / relative
        path.write_bytes(f"owned-media:{user_id}:{relative}".encode())
        paths[user_id].append(path)
        row = Asset(
            user_id=user_id, project_id=project_id, kind=kind, source=source,
            path=relative, mime="image/png", width=32, height=48, parent_id=parent_id,
        )
        session.add(row)
        session.flush()
        if user_id == other_id:
            other_ids[Asset].add(row.id)
        return row

    with factory() as session:
        owner_projects = []
        for user_id, count in [(owner_id, 2), (other_id, 1)]:
            garment = asset(session, user_id, "garment")
            model = asset(session, user_id, "model")
            reference = asset(session, user_id, "reference")
            session.get(User, user_id).profile = {
                "model_asset_ids": [model.id], "height_cm": 170,
                "body_notes": "本人档案", "style_notes": "保留或清理",
            }
            for index in range(count):
                project = Project(
                    user_id=user_id, title=f"事务清理{index}", brand="本地测试", brief="注销测试",
                    garment_asset_ids=[garment.id], model_asset_id=model.id,
                    reference_asset_ids=[reference.id],
                )
                session.add(project)
                session.flush()
                first = asset(
                    session, user_id, "reference", source="generated", project_id=project.id,
                )
                second = asset(
                    session, user_id, "reference", source="generated", project_id=project.id,
                    parent_id=first.id,
                )
                messages = [
                    Message(project_id=project.id, role="user", text="本人素材"),
                    Message(project_id=project.id, role="assistant", text="生成结果"),
                ]
                jobs = [
                    Job(
                        project_id=project.id, user_id=user_id, kind="image", status="succeeded",
                        result_asset_id=second.id, dedupe_key=str(uuid4()),
                    ),
                    Job(
                        project_id=project.id, user_id=user_id, kind="image", status="queued",
                        dedupe_key=str(uuid4()),
                    ),
                ]
                ledger = UsageLedger(
                    project_id=project.id, user_id=user_id, model="mock", kind="image",
                    estimated_cny=Decimal("0.10"), status="settled",
                )
                session.add_all([*messages, *jobs, ledger])
                session.flush()
                if user_id == owner_id:
                    owner_projects.append(project.id)
                else:
                    other_ids[Project].add(project.id)
                    other_ids[Message].update(row.id for row in messages)
                    other_ids[Job].update(row.id for row in jobs)
                    other_ids[UsageLedger].add(ledger.id)
        session.commit()
    client.headers["Authorization"] = "Bearer " + registered["token"]
    return SimpleNamespace(
        credentials=credentials, owner_id=owner_id, other_id=other_id,
        owner_projects=owner_projects, token=registered["token"], paths=paths,
        other_ids=other_ids, baseline=_snapshot(factory),
        original_files={path: path.read_bytes() for group in paths.values() for path in group},
    )


@pytest.fixture
def account_cleanup_api(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'account-cleanup.sqlite'}")

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    rate_limits.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rate_limits, "SessionLocal", factory)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()

    def override_session():
        with factory() as session:
            bind_session(session)
            yield session

    previous_override = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = override_session
    client = TestClient(app, raise_server_exceptions=False)
    try:
        yield client, factory, _seed(client, factory)
    finally:
        client.close()
        if previous_override is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous_override
        engine.dispose()


def _assert_other_untouched(factory, seeded):
    after = _snapshot(factory)
    for model, identities in seeded.other_ids.items():
        before_rows = [row for row in seeded.baseline[model] if row["id"] in identities]
        after_rows = [row for row in after[model] if row["id"] in identities]
        assert after_rows == before_rows
    for path in seeded.paths[seeded.other_id]:
        assert path.read_bytes() == seeded.original_files[path]


def _assert_deleted(client, factory, seeded, *, tombstone=None):
    with factory() as session:
        owner = session.get(User, seeded.owner_id)
        assert owner.deleted_at is not None
        assert owner.username == (tombstone or "deleted-" + seeded.owner_id[:8])
        assert owner.profile == {}
        projects = session.scalars(select(Project).where(Project.user_id == owner.id)).all()
        assert {project.id for project in projects} == set(seeded.owner_projects)
        assert all(project.deleted_at is not None for project in projects)
        assert session.scalars(select(Asset).where(Asset.user_id == owner.id)).all() == []
        assert session.scalars(select(Job).where(Job.user_id == owner.id)).all() == []
        assert session.scalars(select(Message).where(
            Message.project_id.in_(seeded.owner_projects),
        )).all() == []
        assert _rows(session, UsageLedger) == seeded.baseline[UsageLedger]
    assert client.get("/api/me").status_code == 401
    _assert_other_untouched(factory, seeded)


def test_deletion_clears_all_owned_data_and_files_but_preserves_other_users_and_ledger(
    account_cleanup_api,
):
    client, factory, seeded = account_cleanup_api
    response = client.request("DELETE", "/api/me", json={
        "password": seeded.credentials["password"],
    })
    assert response.status_code in {200, 204}
    _assert_deleted(client, factory, seeded)
    assert all(not path.exists() for path in seeded.paths[seeded.owner_id])
    with factory() as session:
        assert session.scalars(select(AppSetting).where(
            AppSetting.key.startswith(CLEANUP_PREFIX, autoescape=True),
        )).all() == []


def test_second_project_cleanup_failure_rolls_back_account_and_first_project(
    account_cleanup_api, monkeypatch,
):
    client, factory, seeded = account_cleanup_api
    original_cleanup = account.cleanup_project
    calls = []

    def fail_second(session, project, *args, **kwargs):
        assert project.user_id == seeded.owner_id
        calls.append(project.id)
        if len(calls) == 2:
            raise RuntimeError("second project cleanup rejected")
        return original_cleanup(session, project, *args, **kwargs)

    monkeypatch.setattr(account, "cleanup_project", fail_second)
    response = client.request("DELETE", "/api/me", json={
        "password": seeded.credentials["password"],
    })
    assert response.status_code == 500
    assert len(calls) == 2 and calls[0] != calls[1]
    assert _snapshot(factory) == seeded.baseline
    for path, content in seeded.original_files.items():
        assert path.read_bytes() == content
    assert client.get("/api/me").status_code == 200


def test_upload_unlink_failure_keeps_committed_outbox_until_retry(
    account_cleanup_api, monkeypatch,
):
    client, factory, seeded = account_cleanup_api
    blocked = seeded.paths[seeded.owner_id][0]
    original_unlink = Path.unlink

    def temporarily_locked(path, *args, **kwargs):
        if path == blocked:
            raise PermissionError("owned test upload temporarily locked")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", temporarily_locked)
    response = client.request("DELETE", "/api/me", json={
        "password": seeded.credentials["password"],
    })
    assert response.status_code in {200, 204}
    _assert_deleted(client, factory, seeded)
    assert blocked.read_bytes() == seeded.original_files[blocked]
    assert all(not path.exists() for path in seeded.paths[seeded.owner_id] if path != blocked)
    with factory() as session:
        pending = session.get(AppSetting, CLEANUP_PREFIX + "account:" + seeded.owner_id)
        assert pending is not None and pending.value["paths"] == [blocked.name]
    monkeypatch.setattr(Path, "unlink", original_unlink)
    with factory() as session:
        drain_media_cleanup(session)
        assert session.get(AppSetting, CLEANUP_PREFIX + "account:" + seeded.owner_id) is None
    assert not blocked.exists()
    _assert_other_untouched(factory, seeded)


def test_occupied_tombstone_username_preserves_occupant_and_releases_original_name(
    account_cleanup_api,
):
    client, factory, seeded = account_cleanup_api
    occupied_name = "deleted-" + seeded.owner_id[:8]
    with factory() as session:
        session.get(User, seeded.other_id).username = occupied_name
        session.commit()
    seeded.baseline = _snapshot(factory)
    response = client.request("DELETE", "/api/me", json={
        "password": seeded.credentials["password"],
    })
    assert response.status_code in {200, 204}
    with factory() as session:
        tombstone = session.get(User, seeded.owner_id).username
        assert re.fullmatch(re.escape(occupied_name) + r"-[0-9a-f]{8}", tombstone)
    _assert_deleted(client, factory, seeded, tombstone=tombstone)
    assert all(not path.exists() for path in seeded.paths[seeded.owner_id])
    replacement = client.post("/api/auth/register", json=seeded.credentials)
    assert replacement.status_code == 200
    assert replacement.json()["user"]["id"] != seeded.owner_id
    assert replacement.json()["user"]["username"] == seeded.credentials["username"]
    _assert_other_untouched(factory, seeded)


def test_shared_media_file_survives_when_another_user_retains_an_asset(account_cleanup_api):
    client, factory, seeded = account_cleanup_api
    shared_path = seeded.paths[seeded.owner_id][0]
    with factory() as session:
        owned = session.scalar(select(Asset).where(
            Asset.user_id == seeded.owner_id, Asset.path == shared_path.name,
        ))
        shared = Asset(
            user_id=seeded.other_id, kind="garment", source="upload", path=owned.path,
            mime=owned.mime, width=owned.width, height=owned.height,
        )
        session.add(shared)
        session.commit()
        owned_id, shared_id = owned.id, shared.id
    seeded.other_ids[Asset].add(shared_id)
    seeded.paths[seeded.other_id].append(shared_path)
    seeded.baseline = _snapshot(factory)

    def media_path(asset_id):
        parsed = urlsplit(signed_url(asset_id))
        return parsed.path + "?" + parsed.query

    original_url, retained_url = media_path(owned_id), media_path(shared_id)
    assert client.get(original_url).status_code == 200
    response = client.request("DELETE", "/api/me", json={
        "password": seeded.credentials["password"],
    })
    assert response.status_code in {200, 204}
    _assert_deleted(client, factory, seeded)
    assert client.get(original_url).status_code == 404
    retained = client.get(retained_url)
    assert retained.status_code == 200 and retained.content == seeded.original_files[shared_path]
    assert shared_path.read_bytes() == seeded.original_files[shared_path]
    assert all(not path.exists() for path in seeded.paths[seeded.owner_id] if path != shared_path)
