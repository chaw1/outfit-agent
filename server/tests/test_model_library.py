"""身份卡迁移、参考顺序、确认门禁与重出，全部使用本机 Mock。"""

import importlib.util
import io
from datetime import timedelta
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, event, inspect, select
from sqlalchemy.orm import Session, sessionmaker

from app import worker
from app.config import settings
from app.main import app
from app.model_library import (
    ANGLES,
    available_model,
    migrate_legacy_models,
    model_dict,
    seed_presets,
)
from app.models import Asset, Base, Job, Model, Project, UsageLedger, User, utcnow
from app.security import current_user, get_session
from app.workflow import Workflow


@pytest.fixture
def library(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'models.sqlite'}")

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    data = io.BytesIO()
    Image.new("RGB", (64, 96), "beige").save(data, "PNG")
    (settings.media_dir / "input.png").write_bytes(data.getvalue())
    with factory() as session:
        user = User(username="models", password_hash="unused", nickname="我的模特")
        other = User(username="other", password_hash="unused", nickname="其他人")
        session.add_all([user, other])
        session.flush()
        photos = [
            Asset(
                user_id=user.id,
                kind="model",
                source="upload",
                mime="image/png",
                path="input.png",
                width=64,
                height=96,
            )
            for _ in range(4)
        ]
        garment = Asset(user_id=user.id, kind="garment", mime="image/png", path="input.png")
        session.add_all([*photos, garment])
        session.flush()
        user.profile = {"model_asset_ids": [photos[0].id]}
        seed_presets(session)
        session.commit()
        ids = {
            "user": user.id,
            "other": other.id,
            "photos": [photo.id for photo in photos],
            "garment": garment.id,
        }
    with factory() as session:
        app.dependency_overrides[get_session] = lambda: session
        app.dependency_overrides[current_user] = lambda: session.get(User, ids["user"])
        client = TestClient(app)
        try:
            yield factory, session, ids, client
        finally:
            client.close()
            app.dependency_overrides.clear()
    engine.dispose()


def build_card(client, ids, count=1):
    body = {"asset_ids": ids["photos"][:count], "name": "本人身份卡"}
    quote = client.post("/api/me/models/quote", json=body)
    assert quote.status_code == 200, quote.text
    created = client.post(
        "/api/me/models", json={**body, "confirmation_token": quote.json()["confirmation_token"]}
    )
    assert created.status_code == 202, created.text
    return created.json(), quote.json(), body


def test_legacy_migration_is_idempotent_and_missing_angles_are_explicit(library):
    _, session, ids, client = library
    first = client.get("/api/me/models").json()
    second = client.get("/api/me/models").json()
    assert first == second
    own = next(model for model in first["items"] if model["user_id"])
    assert own["kind"] == "own" and own["face_asset_id"] == ids["photos"][0]
    assert own["missing"] == list(ANGLES[1:])
    assert own["sheets"][1]["status"] == "missing"
    generated = Asset(
        user_id=ids["user"],
        kind="model",
        source="generated",
        path="input.png",
        mime="image/png",
        analysis={"name": "存为模特"},
    )
    session.add(generated)
    session.commit()
    migrate_legacy_models(session, session.get(User, ids["user"]))
    session.commit()
    migrated = session.scalar(select(Model).where(Model.face_asset_id == generated.id))
    assert migrated.kind == "generated"


def test_presets_seed_idempotent_and_signed_images_are_local(library):
    _, session, _, client = library
    before = session.scalars(select(Model).where(Model.kind == "preset")).all()
    seed_presets(session)
    seed_presets(session)
    session.commit()
    after = session.scalars(select(Model).where(Model.kind == "preset")).all()
    assert len(before) == len(after) == 3
    assert {model.id for model in before} == {model.id for model in after}
    for model in after:
        card = model_dict(session, model)
        assert card["missing"] == [] and len(card["sheet_asset_ids"]) == 4
        assert len(card["identity_text"]) > 40
        from urllib.parse import urlsplit

        url = urlsplit(card["face"]["url"])
        response = client.get(url.path + "?" + url.query)
        assert response.status_code == 200 and response.headers["content-type"] == "image/jpeg"


def test_quote_must_be_confirmed_and_bound_to_photo_owner_and_name(library):
    _, session, ids, client = library
    assert client.post("/api/me/models", json={"asset_ids": ids["photos"][:1]}).status_code == 422
    _, quote, body = build_card(client, ids)
    changed = {
        **body,
        "asset_ids": ids["photos"][:2],
        "confirmation_token": quote["confirmation_token"],
    }
    assert client.post("/api/me/models", json=changed).status_code == 409
    app.dependency_overrides[current_user] = lambda: session.get(User, ids["other"])
    assert (
        client.post(
            "/api/me/models", json={**body, "confirmation_token": quote["confirmation_token"]}
        ).status_code
        == 409
    )
    assert client.post("/api/me/models/quote", json=body).status_code == 422


def test_identity_task_completes_with_three_billed_images_and_deduped_confirmation(library):
    factory, session, ids, client = library
    card, quote, body = build_card(client, ids)
    again = client.post(
        "/api/me/models", json={**body, "confirmation_token": quote["confirmation_token"]}
    ).json()
    assert again["id"] == card["id"] and again["job_id"] == card["job_id"]
    assert quote["generated_count"] == 3 and quote["estimate_points"] > 15
    assert card["status"] == "queued"
    assert worker.run_once(factory)
    session.expire_all()
    ready = next(
        item for item in client.get("/api/me/models").json()["items"] if item["id"] == card["id"]
    )
    assert ready["status"] == "ready" and ready["missing"] == []
    assert ready["identity_text"]
    ledger = session.scalars(
        select(UsageLedger).where(
            UsageLedger.units["job_id"].as_string() == card["job_id"],
        )
    ).all()
    assert [row.kind for row in ledger].count("image") == 3
    assert [row.kind for row in ledger].count("vision") == 1
    assert all(row.user_id == ids["user"] and row.status == "succeeded" for row in ledger)
    assert not worker.run_once(factory)


def test_identity_uses_existing_angles_and_does_not_generate_four_more(library):
    factory, session, ids, client = library
    card, quote, _ = build_card(client, ids, 4)
    assert quote["generated_count"] == 0
    assert worker.run_once(factory)
    session.expire_all()
    model = session.get(Model, card["id"])
    assert model.sheet_asset_ids == ids["photos"] and model.status == "ready"
    assert list(session.scalars(select(UsageLedger.kind))) == ["vision"]


def seed_project(session, ids):
    model = session.scalar(select(Model).where(Model.kind == "preset").order_by(Model.id))
    project = Project(
        user_id=ids["user"],
        title="模特测试",
        brand="个人",
        brief="窗边",
        model_id=model.id,
        model_asset_id=model.face_asset_id,
        garment_asset_ids=[ids["garment"]],
    )
    session.add(project)
    session.flush()
    state = {
        "stage": "script",
        "script": {
            "status": "draft",
            "version": 1,
            "cover": {"scene": "窗边"},
            "shots": [
                {
                    "id": f"shot-{i}",
                    "scene": "窗边",
                    "pose": "站立",
                    "camera": "全身",
                    "outfit_asset_ids": [ids["garment"]],
                }
                for i in range(3)
            ],
        },
    }
    flow = Workflow(session, project)
    flow._action_reply = lambda *args: "确认脚本"
    flow._generate_images(state, {"type": "confirm_script"})
    session.commit()
    return project, model, [item["id"] for item in state["job_intents"]]


def test_reference_order_identity_text_and_cover_are_persisted(library):
    factory, session, ids, _ = library
    project, model, job_ids = seed_project(session, ids)
    cover = session.get(Job, job_ids[0])
    assert cover.payload["reference_asset_ids"] == [*model.sheet_asset_ids[:3], ids["garment"]]
    assert model.identity_text in cover.payload["prompt"]
    session.rollback()
    assert worker.run_once(factory)
    session.expire_all()
    with factory() as claim_session:
        claimed = worker.claim_job(claim_session)
        cover = claim_session.get(Job, job_ids[0])
        assert claimed.payload["reference_asset_ids"] == [
            *model.sheet_asset_ids[:3],
            ids["garment"],
            cover.result_asset_id,
        ]
        assert claimed.project_id == project.id


def test_model_id_overrides_legacy_photo_and_forbids_other_owners(library):
    _, session, ids, client = library
    preset = session.scalar(select(Model).where(Model.kind == "preset"))
    body = {
        "title": "预置可用",
        "brand": "个人",
        "brief": "日常",
        "garment_asset_ids": [ids["garment"]],
        "model_id": preset.id,
        "model_asset_id": "invalid-ignored",
    }
    response = client.post("/api/projects", json=body)
    assert response.status_code == 200, response.text
    project = session.get(Project, response.json()["id"])
    assert project.model_id == preset.id and project.model_asset_id == preset.face_asset_id
    private = Model(
        user_id=ids["other"],
        name="他人的模特",
        kind="own",
        status="ready",
        identity_text="",
        face_asset_id=None,
        sheet_asset_ids=[],
    )
    session.add(private)
    session.commit()
    assert client.post("/api/projects", json={**body, "model_id": private.id}).status_code == 404
    private.status = "building"
    private.user_id = ids["user"]
    session.commit()
    with pytest.raises(Exception, match="身份卡还没准备好"):
        available_model(session, ids["user"], private.id)


def test_low_person_score_reuses_auto_fix_key_and_best_face(library):
    _, session, ids, _ = library
    project, model, job_ids = seed_project(session, ids)
    best = session.get(Job, job_ids[0])
    job = session.get(Job, job_ids[1])
    assets = [
        Asset(
            user_id=ids["user"],
            project_id=project.id,
            kind="reference",
            source="generated",
            path="input.png",
            mime="image/png",
        )
        for _ in range(2)
    ]
    session.add_all(assets)
    session.flush()
    for item, asset, score in zip([best, job], assets, [92, 55], strict=True):
        item.status, item.result_asset_id = "succeeded", asset.id
        item.result = {"fidelity": {"score": 95, "person_score": score, "diffs": []}}
    worker._auto_fix(session, job, assets[1])
    worker._auto_fix(session, job, assets[1])
    session.commit()
    fixes = session.scalars(select(Job).where(Job.kind == "edit")).all()
    assert len(fixes) == 1
    fix = fixes[0]
    assert fix.payload["best_person_asset_id"] == assets[0].id
    assert fix.payload["reference_asset_ids"] == [
        assets[1].id,
        *model.sheet_asset_ids[:3],
        ids["garment"],
        assets[0].id,
    ]
    assert "55" in fix.payload["prompt"] and model.identity_text in fix.payload["prompt"]
    assert fix.payload["auto_fix_reason"] == "person"
    fix.result = {"fidelity": {"score": 90, "person_score": 40}}
    worker._auto_fix(session, fix, assets[1])
    assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 1
    fix.status = "succeeded"
    assert "人像一致性 40" in worker._score_summary([fix])


def test_low_person_fix_obeys_budget_gate(library, monkeypatch):
    _, session, ids, _ = library
    project, _, job_ids = seed_project(session, ids)
    job = session.get(Job, job_ids[0])
    job.result = {"fidelity": {"score": 95, "person_score": 69}}
    from app.errors import AppError

    def denied(*args, **kwargs):
        raise AppError("BUDGET_EXCEEDED", "今日预算不足", 429)

    monkeypatch.setattr(worker, "assert_generation_allowed", denied)
    worker._auto_fix(session, job, session.get(Asset, ids["garment"]))
    assert job.result["auto_fix_skipped"] == "今日预算不足"
    assert not session.scalars(select(Job).where(Job.kind == "edit")).all()
    assert project.model_id


def test_deleted_legacy_model_stays_deleted_and_in_use_model_is_protected(library):
    _, session, ids, client = library
    own = next(item for item in client.get("/api/me/models").json()["items"] if item["user_id"])
    assert client.delete(f"/api/me/models/{own['id']}").status_code == 204
    assert all(item["id"] != own["id"] for item in client.get("/api/me/models").json()["items"])
    project, model, _ = seed_project(session, ids)
    assert client.delete(f"/api/me/models/{model.id}").status_code == 404
    assert project.model_id == model.id


def test_expired_unknown_identity_request_is_failed_without_recharge(library):
    factory, session, ids, client = library
    card, _, _ = build_card(client, ids)
    job = session.get(Job, card["job_id"])
    job.status, job.attempts = "running", 1
    job.locked_at = utcnow() - timedelta(seconds=worker.lease_seconds() + 10)
    job.result = {"external_request_started": True}
    session.commit()
    assert not worker.run_once(factory)
    session.expire_all()
    assert session.get(Model, card["id"]).status == "failed"
    assert session.get(Job, card["job_id"]).status == "failed"
    assert not session.scalars(select(UsageLedger)).all()


def test_model_migration_builds_schema_and_can_downgrade(tmp_path):
    """Exercise actual Alembic operations against the pre-library schema."""
    engine = create_engine(f"sqlite:///{tmp_path / 'migration.sqlite'}")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE users (id VARCHAR(36) PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE assets (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE projects (id VARCHAR(36) PRIMARY KEY, model_asset_id VARCHAR(36))"
        )
        connection.exec_driver_sql(
            "CREATE TABLE jobs (id VARCHAR(36) PRIMARY KEY, project_id VARCHAR(36) NOT NULL)"
        )
        spec = importlib.util.spec_from_file_location(
            "model_migration",
            Path(__file__).parents[1] / "alembic/versions/0012_model_library.py",
        )
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        operations = Operations(MigrationContext.configure(connection))
        migration.op = operations
        migration.upgrade()
        assert "models" in inspect(connection).get_table_names()
        columns = inspect(connection).get_columns("projects")
        assert "model_id" in {column["name"] for column in columns}
        migration.downgrade()
        assert "models" not in inspect(connection).get_table_names()
    engine.dispose()


def test_identity_job_is_queryable_and_admin_can_cancel_without_project(library):
    from app.admin import cancel_job, jobs

    _, session, ids, client = library
    card, _, _ = build_card(client, ids)
    response = client.get(f"/api/jobs/{card['job_id']}")
    assert response.status_code == 200
    assert response.json()["project_id"] is None
    assert response.json()["kind"] == "identity"
    assert any(row["id"] == card["job_id"] for row in jobs(None, 100, session))
    cancelled = cancel_job(card["job_id"], session)
    assert cancelled["cancelled"] and cancelled["status"] == "failed"
    assert session.get(Model, card["id"]).status == "failed"
    app.dependency_overrides[current_user] = lambda: session.get(User, ids["other"])
    assert client.get(f"/api/jobs/{card['job_id']}").status_code == 404


def test_preset_thumbnails_are_cached_in_media_directory(library):
    from app.media import preview_path

    _, session, _, _ = library
    model = session.scalar(select(Model).where(Model.kind == "preset"))
    path = preview_path(session.get(Asset, model.face_asset_id), 360)
    assert path.parent == settings.media_dir and path.is_file()
    with Image.open(path) as image:
        assert image.width <= 360


def test_identity_failed_request_keeps_completed_angles_and_ledger(library, monkeypatch):
    from app.providers import ProviderError, ProviderHub

    factory, session, ids, client = library
    card, _, _ = build_card(client, ids)
    original = ProviderHub.image
    requests = []

    def fail_second(self, *args):
        requests.append(True)
        if len(requests) == 2:
            raise ProviderError("本次角度生成失败")
        return original(self, *args)

    monkeypatch.setattr(ProviderHub, "image", fail_second)
    assert worker.run_once(factory)
    session.expire_all()
    model = session.get(Model, card["id"])
    assert model.status == "failed" and len(model.sheet_asset_ids) == 2
    assert session.get(Job, card["job_id"]).status == "failed"
    assert not worker.run_once(factory)
    rows = session.scalars(select(UsageLedger).where(UsageLedger.kind == "image")).all()
    assert len(rows) == 1 and rows[0].user_id == ids["user"]


@pytest.mark.integration
def test_postgres_upgrade_and_first_read_backfill_are_repeatable(
    isolated_database_url, monkeypatch,
):
    from alembic.config import Config

    from alembic import command

    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    monkeypatch.setattr(settings, "database_url", str(isolated_database_url.render_as_string(
        hide_password=False,
    )))
    command.upgrade(config, "0011")
    engine = create_engine(isolated_database_url)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO users(id,username,password_hash,nickname,profile,created_at) "
            "VALUES ('old-person','old-person','unused','旧档案',"
            "'{\"model_asset_ids\":[\"old-photo\"]}'::jsonb,now())"
        )
        connection.exec_driver_sql(
            "INSERT INTO assets(id,user_id,kind,path,mime,source,created_at) VALUES "
            "('old-photo','old-person','model','old.jpg','image/jpeg','upload',now()),"
            "('saved-model','old-person','model','saved.jpg','image/jpeg','generated',now())"
        )
        connection.exec_driver_sql(
            "INSERT INTO projects(id,user_id,title,brand,brief,stage,garment_asset_ids,"
            "model_asset_id,created_at,updated_at) VALUES "
            "('old-project','old-person','旧片场','本人','原文','images','[]'::jsonb,"
            "'old-photo',now(),now())"
        )
    command.upgrade(config, "head")
    command.upgrade(config, "head")
    with Session(engine) as session:
        user = session.get(User, "old-person")
        for _ in range(2):
            seed_presets(session)
            migrate_legacy_models(session, user)
            session.commit()
        models = session.scalars(select(Model)).all()
        assert len(models) == 5
        assert {model.kind for model in models} == {"preset", "own", "generated"}
        assert session.get(Project, "old-project").model_asset_id == "old-photo"
        assert session.get(Project, "old-project").model_id is None
        assert session.get(Project, "old-project").brief == "原文"
    # Downgrading also handles projects that selected a preset's face.
    with Session(engine) as session:
        preset = session.scalar(select(Model).where(Model.kind == "preset"))
        old = session.get(Project, "old-project")
        old.model_id, old.model_asset_id = preset.id, preset.face_asset_id
        session.commit()
    command.downgrade(config, "0011")
    with engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT model_asset_id FROM projects WHERE id='old-project'"
        ).scalar() is None
    engine.dispose()


def test_expired_identity_and_project_jobs_recover_in_same_claim(library):
    factory, session, ids, client = library
    card, _, _ = build_card(client, ids)
    _, _, job_ids = seed_project(session, ids)
    for job_id in (card["job_id"], job_ids[0]):
        job = session.get(Job, job_id)
        job.status, job.attempts = "running", worker.max_attempts()
        job.locked_at = utcnow() - timedelta(seconds=worker.lease_seconds() + 10)
    session.commit()
    with factory() as claim_session:
        worker.claim_job(claim_session)
        assert claim_session.get(Job, card["job_id"]).status == "failed"
        assert claim_session.get(Job, job_ids[0]).status == "failed"
