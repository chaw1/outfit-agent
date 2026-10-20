"""Runtime choices and quotas use local databases and never call a remote model."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import worker
from app.config import settings
from app.errors import AppError
from app.models import Asset, Base, Job, Project, UsageLedger, User
from app.providers import BudgetExceeded, ProviderHub
from app.runtime_settings import (
    assert_generation_allowed,
    day_bounds,
    get_runtime_settings,
    model_candidates,
    save_runtime_settings,
)
from app.workflow import Workflow


@pytest.fixture
def runtime_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    Image.new("RGB", (32, 48), "white").save(settings.media_dir / "shirt.png")
    monkeypatch.setattr(
        ProviderHub, "_client", lambda self: pytest.fail("runtime tests must never call HTTP")
    )
    engine = create_engine(f"sqlite:///{tmp_path / 'runtime.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        user = User(username="runtime-user", password_hash="unused", nickname="runtime")
        session.add(user)
        session.flush()
        asset = Asset(
            user_id=user.id, kind="garment", path="shirt.png", mime="image/png",
            width=32, height=48,
        )
        session.add(asset)
        session.flush()
        project = Project(
            user_id=user.id, title="runtime", brand="runtime", brief="夏季新品",
            garment_asset_ids=[asset.id],
        )
        session.add(project)
        session.commit()
        ids = user.id, project.id, asset.id
    yield factory, ids
    engine.dispose()


def configure(factory, **values):
    with factory() as session:
        config = deepcopy(get_runtime_settings(session))
        config.update(values)
        save_runtime_settings(session, config)
        session.commit()
        return config


def ledger(factory, ids, amount, *, created_at=None, user_id=None):
    with factory() as session:
        row = UsageLedger(
            project_id=ids[1], user_id=user_id or ids[0], model="test-accounting",
            kind="image", estimated_cny=Decimal(str(amount)),
            **({"created_at": created_at} if created_at is not None else {}),
        )
        session.add(row)
        session.commit()


def queued(factory, ids, *, purpose="preview"):
    with factory() as session:
        job = Job(
            user_id=ids[0], project_id=ids[1], kind="image", dedupe_key=str(uuid4()),
            payload={"prompt": "夏季", "purpose": purpose, "reference_asset_ids": [ids[2]]},
        )
        session.add(job)
        session.commit()
        return job.id


def test_next_provider_call_reads_new_model_in_same_hub_and_accounts_owner(runtime_db):
    factory, ids = runtime_db
    with factory() as session:
        hub = ProviderHub(session, ids[1])
        asset = session.get(Asset, ids[2])
        before = hub.image("穿搭", [asset])
        config = configure(factory)
        config["models"]["image"] = model_candidates()["image"][1]
        configure(factory, **config)
        after = hub.image("新穿搭", [asset])
        assert before.model != after.model == config["models"]["image"]
        rows = session.scalars(select(UsageLedger).order_by(UsageLedger.created_at)).all()
        assert [row.model for row in rows] == [before.model, after.model]
        assert all(row.user_id == ids[0] and row.estimated_cny == 0 for row in rows)


def test_already_queued_worker_uses_new_committed_model(runtime_db):
    factory, ids = runtime_db
    job_id = queued(factory, ids)
    config = configure(factory)
    config["models"]["image"] = model_candidates()["image"][1]
    configure(factory, **config)
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded"
        assert session.get(Asset, job.result_asset_id).model == config["models"]["image"]


def test_daily_user_cap_rejects_preview_script_edit_video_and_keeps_chat(runtime_db):
    factory, ids = runtime_db
    config = configure(factory)
    config["tiers"]["free"]["daily_budget_cny"] = 1
    configure(factory, **config)
    ledger(factory, ids, 1)
    with factory() as session:
        workflow = Workflow(session, session.get(Project, ids[1]))
        state = {"stage": "script", "script": {"shots": []}, "images": []}
        with pytest.raises(AppError, match="今日账号"):
            workflow.validate(state, {"action": {"type": "confirm_script"}})
        with pytest.raises(AppError, match="今日账号"):
            workflow._preview_directions({"directions": []})
        for kind in ("image", "video"):
            with pytest.raises(AppError, match="今日账号"):
                assert_generation_allowed(session, ids[0], kinds=(kind,))
        assert workflow.providers.text("chat", {})["reply"]
        assert session.scalar(select(func.count()).select_from(Job)) == 0


def test_cap_rejects_before_worker_calls_provider(runtime_db, monkeypatch):
    factory, ids = runtime_db
    job_id = queued(factory, ids)
    configure(factory, global_daily_budget_cny=0)
    monkeypatch.setattr(ProviderHub, "image", lambda *args: pytest.fail("paid request submitted"))
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed" and "今日全局" in job.error
        assert session.scalar(select(func.count()).select_from(UsageLedger)) == 0


@pytest.mark.parametrize("action_type", ["edit_image", "confirm_video"])
def test_explicit_media_actions_cannot_queue_at_daily_cap(runtime_db, action_type):
    factory, ids = runtime_db
    job_id = queued(factory, ids, purpose="script")
    configure(factory, global_daily_budget_cny=0)
    with factory() as session:
        job = session.get(Job, job_id)
        job.status, job.result_asset_id = "succeeded", ids[2]
        session.commit()
        workflow = Workflow(session, session.get(Project, ids[1]))
        state = {
            "stage": "note", "note": {"image_ids": [job_id]},
            "script": {"video": {"prompt": "转身"}}, "images": [],
        }
        action = {"type": action_type, "image_id": job_id}
        if action_type == "edit_image":
            action["instruction"] = "背景亮一点"
        with pytest.raises(AppError, match="今日全局"):
            workflow.handle(state, {"action": action})
        assert session.scalar(select(func.count()).select_from(Job)) == 1


def test_disabled_user_cannot_submit_already_queued_job(runtime_db, monkeypatch):
    factory, ids = runtime_db
    job_id = queued(factory, ids)
    with factory() as session:
        session.get(User, ids[0]).disabled = True
        session.commit()
    monkeypatch.setattr(ProviderHub, "image", lambda *args: pytest.fail("paid request submitted"))
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed" and "禁用" in job.error


def test_tier_model_allowlist_and_tier_changes_are_effective_immediately(runtime_db):
    factory, ids = runtime_db
    config = configure(factory)
    config["tiers"]["free"]["models"].remove(config["models"]["image"])
    configure(factory, **config)
    with factory() as session:
        assert session.get(User, ids[0]).tier == "free"
        with pytest.raises(AppError, match="层级"):
            assert_generation_allowed(session, ids[0])
        with factory() as admin:
            admin.get(User, ids[0]).tier = "pro"
            admin.commit()
        assert_generation_allowed(session, ids[0])


@pytest.mark.parametrize("disabled", [False, True])
def test_checkpoint_recovery_cannot_enqueue_over_budget_or_disabled(runtime_db, disabled):
    factory, ids = runtime_db
    configure(factory, global_daily_budget_cny=0)
    with factory() as session:
        session.get(User, ids[0]).disabled = disabled
        session.commit()
        workflow = Workflow(session, session.get(Project, ids[1]))
        workflow.restore_jobs({"job_intents": [{
            "id": str(uuid4()), "kind": "image", "payload": {}, "dedupe_key": "recover-paid",
        }]})
        assert session.scalar(select(func.count()).select_from(Job)) == 0


def test_cancelled_existing_intent_does_not_requeue_during_recovery(runtime_db):
    factory, ids = runtime_db
    job_id = queued(factory, ids)
    with factory() as session:
        job = session.get(Job, job_id)
        job.status, job.error = "failed", "管理员已取消任务。"
        job.result = {"admin_cancelled": True}
        session.commit()
        workflow = Workflow(session, session.get(Project, ids[1]))
        workflow.restore_jobs({"job_intents": [{
            "id": job.id, "kind": "image", "payload": {}, "dedupe_key": job.dedupe_key,
        }]})
        assert session.get(Job, job_id).status == "failed"
        assert session.scalar(select(func.count()).select_from(Job)) == 1


def test_budgets_use_shanghai_midnight_and_other_users_only_count_globally(runtime_db):
    factory, ids = runtime_db
    fixed = datetime(2026, 10, 20, 16, 30, tzinfo=UTC)
    assert day_bounds(fixed) == (
        datetime(2026, 10, 20, 16, tzinfo=UTC), datetime(2026, 10, 21, 16, tzinfo=UTC)
    )
    start, _ = day_bounds()
    ledger(factory, ids, 100, created_at=start - timedelta(microseconds=1))
    config = configure(factory)
    config["tiers"]["free"]["daily_budget_cny"] = 1
    config["global_daily_budget_cny"] = 5
    configure(factory, **config)
    with factory() as session:
        assert_generation_allowed(session, ids[0])
        other = User(username="another", password_hash="unused", nickname="other")
        session.add(other)
        session.commit()
        other_id = other.id
    ledger(factory, ids, 4, user_id=other_id)
    with factory() as session:
        assert_generation_allowed(session, ids[0])
    ledger(factory, ids, 1, user_id=other_id)
    with factory() as session:
        with pytest.raises(AppError, match="今日全局"):
            assert_generation_allowed(session, ids[0])


def test_concurrent_paid_reservations_cannot_both_take_last_allowance(runtime_db, monkeypatch):
    factory, ids = runtime_db
    config = configure(factory)
    config["tiers"]["free"]["daily_budget_cny"] = 0.5
    configure(factory, **config)
    monkeypatch.setattr(settings, "mock_providers", False)

    def reserve():
        with factory() as session:
            try:
                return ProviderHub(session, ids[1])._reserve("image", Decimal("0.5"))
            except BudgetExceeded:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        reservations = list(pool.map(lambda _: reserve(), range(2)))
    assert sum(value is not None for value in reservations) == 1
    with factory() as session:
        assert session.scalar(select(func.sum(UsageLedger.estimated_cny))) == Decimal("0.5")


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -1, True, "10"])
def test_settings_reject_invalid_budget(runtime_db, invalid):
    factory, _ = runtime_db
    with factory() as session:
        config = get_runtime_settings(session)
        config["global_daily_budget_cny"] = invalid
        with pytest.raises(AppError):
            save_runtime_settings(session, config)
