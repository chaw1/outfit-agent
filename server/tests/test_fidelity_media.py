import io
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

import psycopg
import pytest
from PIL import Image
from psycopg import sql
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import media, worker
from app.config import settings
from app.media import asset_path, label_generated_image, signed_url
from app.models import Asset, Base, Job, Message, Project, UsageLedger, User, utcnow
from app.providers import GeneratedMedia, ProviderError, ProviderHub
from app.views import direction_items, image_items, project_cost_cny, project_dict, refresh_cards
from app.workflow import fingerprint


@pytest.fixture
def publication_database_url():
    # These concurrency checks are independent of the API's current mock/real
    # mode; create only a fresh database on the dedicated local test Postgres.
    url = make_url(
        os.environ.get(
            "TEST_DATABASE_URL",
            "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
        )
    )
    assert url.host in {"localhost", "127.0.0.1"} and url.port == 18432
    name = "outfit_publish_test_" + uuid.uuid4().hex
    admin_url = url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield url.set(database=name)
    finally:
        assert name.startswith("outfit_publish_test_") and len(name) == 52
        with psycopg.connect(admin_url, autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
            )


@pytest.fixture
def workbench(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'fidelity.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    output = io.BytesIO()
    Image.new("RGB", (512, 768), "beige").save(output, "PNG")
    data = output.getvalue()
    (settings.media_dir / "garment.png").write_bytes(data)
    with factory() as session:
        user = User(username="fidelity", password_hash="unused", nickname="验证")
        session.add(user)
        session.flush()
        assets = [
            Asset(user_id=user.id, kind="garment", path="garment.png", mime="image/png")
            for _ in range(3)
        ]
        session.add_all(assets)
        session.flush()
        project = Project(
            user_id=user.id,
            title="还原验证",
            brand="测试",
            brief="白色衬衫",
            garment_asset_ids=[asset.id for asset in assets],
        )
        session.add(project)
        session.commit()
        ids = user.id, project.id, [asset.id for asset in assets]
    generated = GeneratedMedia(data, "image/png", "mock-image", 512, 768)
    yield factory, ids, generated
    engine.dispose()


def enqueue(factory, ids, *, shot="shot-1", kind="image", **payload):
    with factory() as session:
        user_id, project_id, garment_ids = ids
        job = Job(
            user_id=user_id,
            project_id=project_id,
            kind=kind,
            payload={
                "shot_id": shot,
                "script_hash": "batch-1",
                "script_version": 3,
                "reference_asset_ids": garment_ids,
                "garment_asset_ids": garment_ids,
                "prompt": "品牌穿搭",
                **payload,
            },
            dedupe_key=f"{project_id}:{shot}:{kind}",
        )
        session.add(job)
        session.commit()
        return job.id


@pytest.mark.parametrize("correction_score", [55, 91])
def test_low_fidelity_gets_one_durable_repair_with_original_garment_references(
    workbench,
    monkeypatch,
    correction_score,
):
    factory, ids, generated = workbench
    references, comparisons = [], []

    def image(self, prompt, assets):
        references.append([asset.id for asset in assets])
        return generated

    def fidelity(self, assets, result):
        comparisons.append([asset.id for asset in assets])
        # One case deliberately stays distorted after repair: never recurse.
        return {
            "score": 42 if len(comparisons) == 1 else correction_score,
            "diffs": ["胸前口袋缺失", "纽扣颜色改变"],
            "auto_fixed": False,
        }

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", fidelity)
    original_id = enqueue(factory, ids)
    assert worker.run_once(factory)
    with factory() as session:
        original = session.get(Job, original_id)
        fix = session.get(Job, original.result["auto_fix_job_id"])
        assert original.status == "succeeded" and fix.status == "queued"
        assert fix.payload["parent_id"] == original_id
        assert fix.payload["parent_asset_id"] == original.result_asset_id
        assert fix.payload["version"] == 2 and fix.payload["script_version"] == 3
        assert "胸前口袋缺失" in fix.payload["instruction"]
        assert fix.payload["reference_asset_ids"] == [original.result_asset_id, *ids[2][:2]]
        assert len(fix.payload["reference_asset_ids"]) == 3
        assert session.scalars(select(Message)).all() == []
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    worker.process_job(original_id, 1, factory)
    with factory() as session:
        jobs = session.scalars(select(Job).order_by(Job.created_at)).all()
        assert len(jobs) == 2 and all(job.status == "succeeded" for job in jobs)
        assert jobs[1].result["fidelity"] == {
            "score": correction_score,
            "diffs": ["胸前口袋缺失", "纽扣颜色改变"],
            "auto_fixed": True,
        }
        assert comparisons == [ids[2], ids[2]]
        assert len(references) == 2
        images = image_items(session, ids[1])
        assert [item["script_version"] for item in images] == [3, 3]
        assert images[1]["parent_id"] == original_id
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 2
        assert any("平均" in message.text and "成功 1 张" in message.text for message in messages)
        assert any(
            "自动还原修复" in message.text and str(correction_score) in message.text
            for message in messages
        )
        corrected = session.get(Asset, jobs[1].result_asset_id)
        assert corrected.parent_id == jobs[0].result_asset_id
        with Image.open(asset_path(corrected)) as tagged:
            assert tagged.info["AIGC"] == "AI生成"
            assert tagged.info["Model"] == "mock-image"


def test_last_image_publishes_one_batch_message_and_preview_is_separate(workbench, monkeypatch):
    factory, ids, generated = workbench
    monkeypatch.setattr(ProviderHub, "image", lambda *args: generated)
    scored = []

    def fidelity(*args):
        scored.append(True)
        return {"score": 94, "diffs": [], "auto_fixed": False}

    monkeypatch.setattr(ProviderHub, "fidelity", fidelity)
    preview_id = enqueue(factory, ids, shot="preview-1", purpose="preview", direction_id="d1")
    first = enqueue(factory, ids, shot="shot-1")
    second = enqueue(factory, ids, shot="shot-2")
    assert worker.run_once(factory)
    with factory() as session:
        assert image_items(session, ids[1])[0]["id"] == first
        assert len(image_items(session, ids[1])) == 2
        assert project_dict(session.get(Project, ids[1]), session)["cover_url"] is None
        directions = direction_items(session, ids[1], [{"id": "d1", "name": "城市"}])
        assert directions[0]["preview_status"] == "succeeded"
        assert session.get(Job, preview_id).result_asset_id in directions[0]["preview_url"]
        assert session.scalars(select(Message)).all() == []
    assert worker.run_once(factory)
    with factory() as session:
        assert session.scalars(select(Message)).all() == []
    assert worker.run_once(factory)
    worker.process_job(second, 1, factory)
    with factory() as session:
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 1
        assert "2 张" in messages[0].text and "94" in messages[0].text
        assert len(scored) == 2


def test_fidelity_outage_keeps_paid_generated_image_and_does_not_regenerate(workbench, monkeypatch):
    factory, ids, generated = workbench
    calls = []

    def image(*args):
        calls.append(True)
        return generated

    def unavailable(*args):
        raise ProviderError("看图服务暂不可用。", retryable=True)

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", unavailable)
    job_id = enqueue(factory, ids)
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded" and job.result_asset_id
        assert "fidelity_error" in job.result and "fidelity" not in job.result
        assert len(calls) == 1


def test_video_completion_publishes_one_message_with_source_fidelity(workbench, monkeypatch):
    factory, ids, generated = workbench
    monkeypatch.setattr(ProviderHub, "image", lambda *args: generated)
    monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 93, "diffs": []})
    source_job_id = enqueue(factory, ids)
    assert worker.run_once(factory)
    with factory() as session:
        source_id = session.get(Job, source_job_id).result_asset_id
    monkeypatch.setattr(
        ProviderHub,
        "video",
        lambda *args, **kwargs: GeneratedMedia(
            b"unit-video",
            "video/mp4",
            "mock-video",
        ),
    )
    video_id = enqueue(factory, ids, kind="video", image_id=source_job_id, image_asset_id=source_id)
    assert worker.run_once(factory)
    worker.process_job(video_id, 1, factory)
    with factory() as session:
        messages = session.scalars(select(Message).order_by(Message.created_at)).all()
        assert len(messages) == 2
        assert "1 条 5 秒" in messages[-1].text and "93" in messages[-1].text
        card = refresh_cards(messages[-1].cards, session, ids[1])[0]
        assert card["status"] == "succeeded" and source_id in card["poster_url"]
        assert session.get(Job, video_id).result_asset_id in card["url"]


@pytest.mark.integration
def test_two_workers_publish_exactly_one_batch_completion(
    publication_database_url,
    workbench,
    monkeypatch,
):
    original_factory, ids, generated = workbench
    engine = create_engine(publication_database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        with original_factory() as source, factory() as target:
            for model in [User, Asset, Project]:
                for item in source.scalars(select(model)).all():
                    target.add(
                        model(
                            **{
                                column.name: getattr(item, column.name)
                                for column in model.__table__.columns
                            }
                        )
                    )
                target.flush()
            target.commit()
        first = enqueue(factory, ids, shot="shot-1")
        second = enqueue(factory, ids, shot="shot-2")
        barrier = threading.Barrier(2)

        def image(*args):
            barrier.wait(timeout=5)
            return generated

        monkeypatch.setattr(ProviderHub, "image", image)
        monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 95, "diffs": []})
        with ThreadPoolExecutor(max_workers=2) as threads:
            assert list(threads.map(lambda _: worker.run_once(factory), range(2))) == [True, True]
        with factory() as session:
            assert session.get(Job, first).status == session.get(Job, second).status == "succeeded"
            messages = session.scalars(select(Message)).all()
            assert len(messages) == 1 and "2 张" in messages[0].text
    finally:
        engine.dispose()


def test_signed_urls_are_stable_for_six_hours_and_valid_at_least_one_day(monkeypatch):
    window = 6 * 60 * 60
    start = 20 * window
    monkeypatch.setattr(media.time, "time", lambda: start + 1)
    first = signed_url("asset")
    expiry = int(parse_qs(urlsplit(first).query)["exp"][0])
    assert 86400 <= expiry - (start + 1) <= 86400 + window
    monkeypatch.setattr(media.time, "time", lambda: start + window - 1)
    assert signed_url("asset") == first
    assert expiry - (start + window - 1) >= 86400
    monkeypatch.setattr(media.time, "time", lambda: start + window)
    assert signed_url("asset") != first
    assert "exp=12&" in signed_url("asset", exp=12)


@pytest.mark.integration
@pytest.mark.parametrize("provider_fails", [False, True])
def test_publication_rechecks_attempt_after_waiting_for_batch_lock(
    publication_database_url,
    workbench,
    monkeypatch,
    provider_fails,
):
    original_factory, ids, generated = workbench
    engine = create_engine(publication_database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    waiting = threading.Event()
    try:
        with original_factory() as source, factory() as target:
            for model in [User, Asset, Project]:
                for item in source.scalars(select(model)).all():
                    target.add(
                        model(
                            **{
                                column.name: getattr(item, column.name)
                                for column in model.__table__.columns
                            }
                        )
                    )
                target.flush()
            target.commit()
        job_id = enqueue(factory, ids)
        with factory() as session:
            job = session.get(Job, job_id)
            job.status, job.attempts, job.locked_at = "running", 1, utcnow()
            session.commit()

        def image(*args):
            if provider_fails:
                raise ProviderError("模型暂不可用。")
            return generated

        monkeypatch.setattr(ProviderHub, "image", image)
        monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 95, "diffs": []})
        completion_lock = worker._completion_lock
        with factory() as lease_owner, ThreadPoolExecutor(max_workers=1) as threads:
            job = lease_owner.get(Job, job_id)
            completion_lock(lease_owner, job)

            def observed_lock(session, snapshot):
                waiting.set()
                return completion_lock(session, snapshot)

            monkeypatch.setattr(worker, "_completion_lock", observed_lock)
            future = threads.submit(worker.process_job, job_id, 1, factory)
            try:
                assert waiting.wait(timeout=5)
                lease_owner.execute(text("SET LOCAL lock_timeout = '1s'"))
                # This must not wait for a row held by the stale worker while
                # that worker waits for our batch lock (the old inverted order).
                job.attempts = 2
                lease_owner.commit()
            finally:
                lease_owner.rollback()
            future.result(timeout=5)
        with factory() as session:
            job = session.get(Job, job_id)
            assert job.status == "running" and job.attempts == 2
            assert job.result_asset_id is None and job.error is None
            assert session.scalars(select(Message)).all() == []
            assert session.scalars(select(Asset).where(Asset.source == "generated")).all() == []
    finally:
        engine.dispose()


@pytest.mark.parametrize("unknown,kind", [(True, "image"), (False, "image"), (False, "video")])
def test_expired_terminal_job_publishes_failure_summary_once(workbench, unknown, kind):
    factory, ids, _ = workbench
    first = enqueue(factory, ids, shot="shot-1")
    expired_id = enqueue(factory, ids, shot="shot-2", kind=kind)
    with factory() as session:
        finished = session.get(Job, first)
        finished.status, finished.result = "succeeded", {"fidelity": {"score": 93, "diffs": []}}
        expired = session.get(Job, expired_id)
        expired.status = "running"
        expired.attempts = 1 if unknown else worker.max_attempts()
        expired.locked_at = utcnow() - timedelta(seconds=worker.lease_seconds() + 1)
        expired.result = {"external_request_started": unknown}
        session.commit()
    assert not worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        assert session.get(Job, expired_id).status == "failed"
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 1
        if kind == "image":
            assert "成功 1 张" in messages[0].text and "1 个任务失败" in messages[0].text
        else:
            assert "1 条 5 秒视频未能完成" in messages[0].text


def test_preview_matches_direction_content_when_ids_are_reused(workbench):
    factory, ids, _ = workbench
    old = {"id": "direction-1", "name": "自然", "scene": "公园"}
    new = {"id": "direction-1", "name": "通勤", "scene": "写字楼"}
    with factory() as session:
        for index, direction in enumerate([old, new]):
            session.add(
                Job(
                    user_id=ids[0],
                    project_id=ids[1],
                    kind="image",
                    status="succeeded",
                    payload={"purpose": "preview", "direction_id": direction["id"]},
                    dedupe_key=f"{ids[1]}:preview:{fingerprint(direction)}",
                    result_asset_id=ids[2][index],
                )
            )
        session.commit()
        old_projected = direction_items(session, ids[1], [{**old, "preview_status": "queued"}])[0]
        new_projected = direction_items(session, ids[1], [new])[0]
        assert ids[2][0] in old_projected["preview_url"]
        assert ids[2][1] in new_projected["preview_url"]
        assert old_projected["preview_status"] == new_projected["preview_status"] == "succeeded"
        missing = direction_items(session, ids[1], [{**new, "scene": "咖啡馆"}])[0]
        assert "preview_url" not in missing


def test_generated_label_changes_pixels_and_embeds_disclosure(workbench):
    _, _, generated = workbench
    with Image.open(io.BytesIO(label_generated_image(generated.data, "image-model"))) as image:
        assert image.info["AIGC"] == "AI生成" and image.info["Source"] == "generated"
        assert image.getpixel((480, 750)) != (245, 245, 220)
        assert image.getpixel((10, 10)) == (245, 245, 220)


def test_cost_projection_uses_ledger_including_uncertain_paid_calls(workbench):
    factory, ids, _ = workbench
    with factory() as session:
        session.add_all(
            [
                UsageLedger(
                    project_id=ids[1],
                    model="image",
                    kind="image",
                    estimated_cny=Decimal(cost),
                    status=status,
                )
                for cost, status in [("0.5", "succeeded"), ("0.02", "failed"), ("0.1", "reserved")]
            ]
        )
        session.add(UsageLedger(project_id="other", model="image", kind="image", estimated_cny=8))
        session.commit()
        assert project_cost_cny(session, ids[1]) == 0.62
        card = refresh_cards([{"id": "note", "type": "note", "title": "正文"}], session, ids[1])[0]
        assert card["cost_cny"] == 0.62 and "AI" in card["ai_label"]
