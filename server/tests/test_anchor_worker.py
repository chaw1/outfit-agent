"""Cover dependencies and identity scoring, with no external model requests."""

import io
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import worker
from app.config import settings
from app.models import Asset, Base, Job, Message, Project, User, utcnow
from app.providers import GeneratedMedia, ProviderError, ProviderHub
from app.views import image_items
from app.workflow import Workflow


def seed_batch(factory, *, model=True):
    with factory() as session:
        user = User(username="anchor", password_hash="unused", nickname="封面")
        session.add(user)
        session.flush()
        garments = [
            Asset(user_id=user.id, kind="garment", path="source.png", mime="image/png")
            for _ in range(2)
        ]
        person = Asset(user_id=user.id, kind="model", path="source.png", mime="image/png")
        session.add_all([*garments, person])
        session.flush()
        project = Project(
            user_id=user.id, title="封面", brand="品牌", brief="自然光",
            garment_asset_ids=[item.id for item in garments],
            model_asset_id=person.id if model else None,
        )
        session.add(project)
        session.flush()
        state = {
            "stage": "script",
            "script": {
                "status": "draft", "version": 1, "cover": {"scene": "窗边"},
                "shots": [
                    {"id": f"shot-{i}", "scene": "窗边", "pose": "站立", "camera": "全身",
                     "outfit_asset_ids": project.garment_asset_ids}
                    for i in range(3)
                ],
            },
        }
        workflow = Workflow(session, project)
        workflow._action_reply = lambda *args: "脚本确认了。"
        workflow._generate_images(state, {"type": "confirm_script"})
        ids = [item["id"] for item in state["job_intents"]]
        # Waiting shots sort before the cover: eligibility, not FIFO, must
        # enforce the dependency after any restart or worker count change.
        for job_id in ids[1:]:
            session.get(Job, job_id).available_at = utcnow() - timedelta(seconds=20)
        session.commit()
        return project.id, ids, state


@pytest.fixture
def anchor_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'anchor.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    output = io.BytesIO()
    Image.new("RGB", (128, 192), "beige").save(output, "PNG")
    data = output.getvalue()
    (settings.media_dir / "source.png").write_bytes(data)
    generated = GeneratedMedia(data, "image/png", "mock-image", 128, 192)
    calls, inspections = [], []

    def image(self, prompt, assets):
        calls.append({"job_id": self.trace_context["job_id"], "prompt": prompt,
                      "references": [asset.id for asset in assets]})
        return generated

    def fidelity(self, originals, media, **identity):
        inspections.append({key: asset.id for key, asset in identity.items()})
        return {
            "score": 94, "diffs": [], "auto_fixed": False,
            **({"person_score": 93} if identity.get("model_asset") else {}),
            **({"anchor_score": 92} if identity.get("anchor_asset") else {}),
        }

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", fidelity)
    yield factory, calls, inspections
    engine.dispose()


def test_cover_first_then_parallel_references_identity_and_notification(anchor_db):
    factory, calls, inspections = anchor_db
    project_id, ids, _ = seed_batch(factory)
    with factory() as first, factory() as second:
        cover = worker.claim_job(first)
        assert cover.id == ids[0]
        assert worker.claim_job(second) is None
    worker.process_job(ids[0], 1, factory)
    # Claim in separate sessions before either completes: remaining shots can
    # execute concurrently, and the anchor decision is persisted at claim.
    with factory() as first, factory() as second:
        one, two = worker.claim_job(first), worker.claim_job(second)
        assert {one.id, two.id} == set(ids[1:])
        cover = first.get(Job, ids[0])
        anchor_asset_id = cover.result_asset_id
        expected = [first.get(Project, project_id).model_asset_id,
                    *first.get(Project, project_id).garment_asset_ids, anchor_asset_id]
        for item in (one, two):
            assert item.payload["anchor_id"] == cover.id
            assert item.payload["anchor_id"] != anchor_asset_id
            assert item.payload["reference_asset_ids"] == expected
    for job_id in ids[1:]:
        worker.process_job(job_id, 1, factory)
    assert [item["job_id"] for item in calls] == ids
    assert all(item["references"] == expected for item in calls[1:])
    assert all("同一光线" in item["prompt"] for item in calls[1:])
    assert "anchor_asset" not in inspections[0]
    assert all(item["anchor_asset"] == anchor_asset_id for item in inspections[1:])
    with factory() as session:
        images = image_items(session, project_id)
        cover = next(item for item in images if item["id"] == ids[0])
        assert "anchor_id" not in cover and "anchor_score" not in cover["fidelity"]
        assert cover["fidelity"]["person_score"] == 93
        assert all(item["anchor_id"] == ids[0] for item in images if item["id"] != ids[0])
        notifications = session.scalars(select(Message)).all()
        assert len(notifications) == 1
        assert "人像一致性 93" in notifications[0].text
        assert "封面一致性 92" in notifications[0].text


def test_cover_transient_failure_never_releases_waiting_shots(anchor_db, monkeypatch):
    factory, calls, _ = anchor_db
    _, ids, _ = seed_batch(factory)
    original = ProviderHub.image

    def busy_once(self, *args):
        if not calls:
            calls.append({"failed": True})
            raise ProviderError("繁忙", retryable=True)
        return original(self, *args)

    monkeypatch.setattr(ProviderHub, "image", busy_once)
    assert worker.run_once(factory)
    with factory() as session:
        cover = session.get(Job, ids[0])
        assert cover.status == "queued"
        assert worker.claim_job(session) is None
        cover.available_at = utcnow() - timedelta(seconds=1)
        session.commit()
    assert worker.run_once(factory)
    with factory() as session:
        assert worker.claim_job(session).payload["anchor_id"] == ids[0]


@pytest.mark.parametrize("cancelled", [False, True])
def test_terminal_cover_failure_or_cancellation_releases_parallel_without_anchor(
    anchor_db, monkeypatch, cancelled,
):
    factory, _, _ = anchor_db
    project_id, ids, _ = seed_batch(factory, model=False)
    if cancelled:
        with factory() as session:
            cover = session.get(Job, ids[0])
            cover.status, cover.result = "failed", {"admin_cancelled": True}
            session.commit()
    else:
        def reject(*args):
            raise ProviderError("封面失败")
        monkeypatch.setattr(ProviderHub, "image", reject)
        assert worker.run_once(factory)
    with factory() as first, factory() as second:
        one, two = worker.claim_job(first), worker.claim_job(second)
        assert {one.id, two.id} == set(ids[1:])
        for item in (one, two):
            assert "anchor_id" not in item.payload
            assert "anchor_asset_id" not in item.payload
            assert item.payload["reference_asset_ids"] == first.get(
                Project, project_id
            ).garment_asset_ids


def test_no_identity_old_job_retains_default_fields_and_payload(anchor_db):
    factory, _, inspections = anchor_db
    project_id, ids, _ = seed_batch(factory, model=False)
    assert worker.run_once(factory)
    with factory() as session:
        cover = session.get(Job, ids[0])
        assert "anchor_job_id" not in cover.payload and "model_asset_id" not in cover.payload
        image = next(item for item in image_items(session, project_id) if item["id"] == ids[0])
        assert "anchor_id" not in image
        assert set(image["fidelity"]) == {"score", "diffs", "auto_fixed"}
    assert inspections == [{}]


def test_graph_intent_restores_dependency_and_cancelled_shot_stays_cancelled(anchor_db):
    factory, _, _ = anchor_db
    project_id, ids, state = seed_batch(factory)
    with factory() as session:
        missing = session.get(Job, ids[1])
        session.delete(missing)
        cancelled = session.get(Job, ids[2])
        cancelled.status, cancelled.result = "failed", {"admin_cancelled": True}
        session.commit()
    with factory() as session:
        workflow = Workflow(session, session.get(Project, project_id))
        workflow.restore_jobs(state)
        session.commit()
        assert session.get(Job, ids[1]).payload["anchor_job_id"] == ids[0]
        assert session.get(Job, ids[2]).status == "failed"
        assert worker.claim_job(session).id == ids[0]
    with factory() as session:
        assert worker.claim_job(session) is None
        session.get(Project, project_id).deleted_at = utcnow()
        session.commit()
    worker.process_job(ids[0], 1, factory)
    with factory() as session:
        assert worker.claim_job(session) is None
        assert session.scalars(select(Message)).all() == []


def test_cover_auto_repair_finishes_before_dependents_and_anchors_repaired_version(
    anchor_db, monkeypatch,
):
    factory, calls, _ = anchor_db
    _, ids, _ = seed_batch(factory)
    original = ProviderHub.fidelity

    def low_cover(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        return {**result, "score": 45, "diffs": ["纽扣缺失"]} if len(calls) == 1 else result

    monkeypatch.setattr(ProviderHub, "fidelity", low_cover)
    assert worker.run_once(factory)
    with factory() as first, factory() as second:
        cover = first.get(Job, ids[0])
        repair_id = cover.result["auto_fix_job_id"]
        repair = worker.claim_job(first)
        assert repair.id == repair_id
        assert worker.claim_job(second) is None
    worker.process_job(repair_id, 1, factory)
    with factory() as session:
        next_job = worker.claim_job(session)
        assert next_job.id in ids[1:]
        assert next_job.payload["anchor_id"] == repair_id
        assert next_job.payload["anchor_asset_id"] == session.get(Job, repair_id).result_asset_id


def test_failed_cover_repair_uses_original_successful_cover(anchor_db, monkeypatch):
    factory, _, _ = anchor_db
    _, ids, _ = seed_batch(factory)
    original = ProviderHub.fidelity

    def low_cover(self, *args, **kwargs):
        return {**original(self, *args, **kwargs), "score": 45, "diffs": ["纽扣缺失"]}

    monkeypatch.setattr(ProviderHub, "fidelity", low_cover)
    assert worker.run_once(factory)
    with factory() as session:
        cover = session.get(Job, ids[0])
        repair = session.get(Job, cover.result["auto_fix_job_id"])
        repair.status, repair.error = "failed", "修复失败"
        session.commit()
    with factory() as session:
        claimed = worker.claim_job(session)
        assert claimed.id in ids[1:]
        assert claimed.payload["anchor_id"] == ids[0]
        assert claimed.payload["anchor_asset_id"] == session.get(Job, ids[0]).result_asset_id


@pytest.mark.parametrize("ambiguous", [False, True])
def test_expired_cover_terminal_recovery_releases_dependents(anchor_db, ambiguous):
    factory, _, _ = anchor_db
    _, ids, _ = seed_batch(factory)
    with factory() as session:
        cover = session.get(Job, ids[0])
        cover.status = "running"
        cover.attempts = 1 if ambiguous else worker.max_attempts()
        cover.locked_at = utcnow() - timedelta(seconds=worker.lease_seconds() + 1)
        cover.result = {"external_request_started": True} if ambiguous else {}
        session.commit()
    with factory() as session:
        claimed = worker.claim_job(session)
        assert claimed.id in ids[1:]
        assert "anchor_id" not in claimed.payload
        assert session.get(Job, ids[0]).status == "failed"


@pytest.mark.integration
def test_postgres_multiple_workers_cannot_bypass_cover_and_can_claim_remaining_together(
    isolated_database_url,
):
    engine = create_engine(isolated_database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        project_id, ids, _ = seed_batch(factory)
        with factory() as session:
            assert worker.claim_job(session).id == ids[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            def claim():
                with factory() as session:
                    job = worker.claim_job(session)
                    return job.id if job else None
            assert list(pool.map(lambda _: claim(), range(2))) == [None, None]
            with factory() as session:
                cover = session.get(Job, ids[0])
                asset = Asset(
                    user_id=cover.user_id, project_id=project_id, kind="reference",
                    path="cover.png", mime="image/png", source="generated",
                )
                session.add(asset)
                session.flush()
                cover.status, cover.result_asset_id = "succeeded", asset.id
                session.commit()
            assert set(pool.map(lambda _: claim(), range(2))) == set(ids[1:])
    finally:
        engine.dispose()
