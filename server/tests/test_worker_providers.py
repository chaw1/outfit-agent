import base64
import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import providers, worker
from app.config import settings
from app.models import Asset, Base, Job, Project, UsageLedger, User, utcnow
from app.providers import BudgetExceeded, GeneratedMedia, ProviderError, ProviderHub


@pytest.fixture
def local_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'unit.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    data = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(data, "PNG")
    (settings.media_dir / "source.png").write_bytes(data.getvalue())
    with factory() as session:
        user = User(username="unit", password_hash="unused", nickname="unit")
        session.add(user)
        session.flush()
        asset = Asset(
            user_id=user.id,
            kind="garment",
            path="source.png",
            width=32,
            height=48,
            mime="image/png",
            source="upload",
        )
        session.add(asset)
        session.flush()
        project = Project(
            user_id=user.id,
            title="unit",
            brand="unit",
            brief="夏季新品",
            garment_asset_ids=[asset.id],
        )
        session.add(project)
        session.commit()
        ids = user.id, project.id, asset.id
    yield factory, ids
    engine.dispose()


def add_job(factory, ids, *, kind="image", payload=None, **values):
    user_id, project_id, asset_id = ids
    with factory() as session:
        job = Job(
            user_id=user_id,
            project_id=project_id,
            kind=kind,
            payload=payload or {"prompt": "轻松日常", "reference_asset_ids": [asset_id]},
            dedupe_key=f"unit-{utcnow().isoformat()}",
            **values,
        )
        session.add(job)
        session.commit()
        return job.id


def test_mock_all_providers_never_create_http_client(local_db, monkeypatch):
    factory, (_, project_id, asset_id) = local_db

    def no_client(self):
        raise AssertionError("Mock must never use HTTP")

    monkeypatch.setattr(ProviderHub, "_client", no_client)
    with factory() as session:
        hub = ProviderHub(session, project_id)
        asset = session.get(Asset, asset_id)
        garments = hub.analyze_garments([asset])
        context = {"garments": garments, "image_ids": ["image-1"]}
        directions = hub.text("propose_directions", context)
        assert len(directions["options"]) == 3
        script = hub.text("write_script", context)
        revised = hub.text("revise_script", context, "换成通勤风")
        assert len(script["shots"]) >= 4
        assert revised["shots"][0]["outfit_asset_ids"] == [asset_id]
        assert revised["shots"][0]["scene"] != script["shots"][0]["scene"]
        assert "通勤" in revised["shots"][0]["caption"]
        note = hub.text("write_note", context)
        assert len(note["title"]) <= 20 and 5 <= len(note["tags"]) <= 8
        assert note["image_ids"] == ["image-1"]
        assert hub.image("日常", [asset]).data.startswith(b"\x89PNG")
        submitted = []
        video = hub.video("轻轻转身", asset, on_submitted=submitted.append)
        assert video.data[4:8] == b"ftyp" and submitted[0].startswith("mock-")
        records = session.scalars(select(UsageLedger)).all()
        assert len(records) == 7
        assert all(row.estimated_cny == 0 and row.status == "succeeded" for row in records)


def test_text_uses_only_current_function_and_accounts_actual_usage(local_db, monkeypatch):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "unit-test-placeholder")

    def handler(request):
        body = json.loads(request.content)
        assert [tool["function"]["name"] for tool in body["tools"]] == ["chat"]
        assert body["tool_choice"] == "required"
        assert body["thinking"] == {"type": "disabled"}
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "chat",
                                        "arguments": ('{"text":"轻松一点就很好～",'
                                                      '"reply":"轻松一点就很好～"}'),
                                    },
                                }
                            ]
                        }
                    }
                ],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
            },
        )

    monkeypatch.setattr(
        ProviderHub,
        "_client",
        lambda self: httpx.Client(
            transport=httpx.MockTransport(handler),
        ),
    )
    with factory() as session:
        assert ProviderHub(session, project_id).text("chat", {})["text"]
        ledger = session.scalar(select(UsageLedger))
        assert ledger.units["prompt_tokens"] == 1000
        assert ledger.estimated_cny == Decimal("0.003150")
        assert ledger.duration_ms >= 0
        with pytest.raises(ProviderError, match="不允许"):
            ProviderHub(session, project_id).text("delete_project", {})


def test_ten_garments_are_analyzed_in_accounted_batches(local_db):
    factory, (user_id, project_id, _) = local_db
    with factory() as session:
        assets = [
            Asset(
                user_id=user_id,
                kind="garment",
                path="source.png",
                mime="image/png",
                source="upload",
            )
            for _ in range(10)
        ]
        session.add_all(assets)
        session.commit()
        result = ProviderHub(session, project_id).analyze_garments(assets)
        assert [item["asset_id"] for item in result] == [asset.id for asset in assets]
        records = session.scalars(select(UsageLedger).order_by(UsageLedger.created_at)).all()
        assert [row.units["images"] for row in records] == [6, 4]
        assert all(row.estimated_cny == 0 for row in records)


def test_reference_copies_are_compressed_and_original_file_is_unchanged(local_db):
    factory, (_, _, asset_id) = local_db
    path = settings.media_dir / "source.png"
    Image.effect_noise((2400, 1600), 80).convert("RGB").save(path, "PNG")
    original = path.read_bytes()
    with factory() as session:
        asset = session.get(Asset, asset_id)
        for vision, dimensions in [(False, (1536, 1024)), (True, (1024, 683))]:
            value = ProviderHub._data_url(asset, vision=vision)
            assert value.startswith("data:image/jpeg;base64,")
            encoded = base64.b64decode(value.split(",", 1)[1])
            with Image.open(io.BytesIO(encoded)) as image:
                assert image.format == "JPEG" and image.mode == "RGB"
                assert image.size == dimensions
            assert len(encoded) < len(original) * 0.7
        assert asset.path == "source.png" and asset.mime == "image/png"
    assert path.read_bytes() == original


def test_reference_copy_applies_exif_orientation_without_mutating_source(local_db):
    factory, (_, _, asset_id) = local_db
    path = settings.media_dir / "source.png"
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (80, 120), "white").save(path, "JPEG", exif=exif)
    original = path.read_bytes()
    with factory() as session:
        value = ProviderHub._data_url(session.get(Asset, asset_id))
    with Image.open(io.BytesIO(base64.b64decode(value.split(",", 1)[1]))) as image:
        assert image.size == (120, 80)
        assert image.getexif().get(274) is None
    assert path.read_bytes() == original


def test_failed_call_records_only_exception_class_and_keeps_cost_reservation(local_db, monkeypatch):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)

    def interrupted():
        raise httpx.ReadError("private-url private-header private-token")

    with factory() as session:
        with pytest.raises(httpx.ReadError):
            ProviderHub(session, project_id)._call("image", "0.50", interrupted)
        ledger = session.scalar(select(UsageLedger))
        assert ledger.status == "failed" and ledger.estimated_cny == Decimal("0.500000")
        assert ledger.units["error_type"] == "ReadError"
        assert "private" not in json.dumps(ledger.units)


def test_postgres_accounting_pool_is_independent_and_cached_across_threads(monkeypatch):
    # Engine construction is lazy: this test creates no network connection.
    engine = create_engine(
        "postgresql+psycopg://unit:unused@127.0.0.1:18432/unit", pool_size=1, max_overflow=0
    )
    monkeypatch.setattr(providers, "_ledger_engines", {})
    with sessionmaker(engine)() as session:
        hub = ProviderHub(session)
        with ThreadPoolExecutor(max_workers=8) as threads:
            binds = list(threads.map(lambda _: hub._ledger_bind(), range(16)))
        assert all(bind is binds[0] and bind is not engine for bind in binds)
        assert binds[0].pool is not engine.pool
        binds[0].dispose()
    engine.dispose()


def test_budget_rejects_before_network(local_db, monkeypatch):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)
    with factory() as session:
        session.add(
            UsageLedger(
                project_id=project_id,
                model="unit",
                kind="image",
                estimated_cny=Decimal("11.95"),
                status="reserved",
            )
        )
        session.commit()
        with pytest.raises(BudgetExceeded):
            ProviderHub(session, project_id).text("chat", {})


def test_large_prompt_reserves_its_maximum_token_cost(local_db, monkeypatch):
    factory, (_, project_id, _) = local_db
    monkeypatch.setattr(settings, "mock_providers", False)
    with factory() as session:
        session.add(
            UsageLedger(
                project_id=project_id,
                model="unit",
                kind="image",
                estimated_cny=Decimal("11.70"),
                status="reserved",
            )
        )
        session.commit()
        with pytest.raises(BudgetExceeded):
            ProviderHub(session, project_id).text("chat", {"long": "衣服" * 100_000})


def test_nested_tool_output_and_asset_references_are_validated():
    with pytest.raises(ProviderError, match="字段不完整"):
        ProviderHub._validate_text("write_script", {"status": "draft"}, {})
    script = ProviderHub._mock_text("write_script", {"garment_asset_ids": ["a"]}, "")
    with pytest.raises(ProviderError, match="当前项目"):
        ProviderHub._validate_text("write_script", script, {"garment_asset_ids": ["b"]})


def test_mock_note_revision_retains_images_and_changes_title():
    original = ProviderHub._mock_text("write_note", {"image_ids": ["a", "b"]}, "")
    revised = ProviderHub._mock_text(
        "write_note",
        {
            "note": original,
            "selected_image_ids": ["a", "b"],
        },
        "保留原笔记未要求更改的内容，落实以下修改：标题改成：轻松通勤日常",
    )
    assert revised["title"] == "轻松通勤日常"
    assert revised["body"] == original["body"] and revised["image_ids"] == ["a", "b"]


def test_job_succeeds_and_repeat_processing_is_idempotent(local_db):
    factory, ids = local_db
    job_id = add_job(factory, ids)
    assert worker.run_once(factory)
    worker.process_job(job_id, 1, factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded" and job.attempts == 1
        assert job.result_asset_id
        assets = session.scalars(select(Asset).where(Asset.source == "generated")).all()
        assert len(assets) == 1
        assert assets[0].project_id == ids[1]


def test_transient_failure_retries_then_succeeds(local_db, monkeypatch):
    factory, ids = local_db
    job_id = add_job(factory, ids)
    original = ProviderHub.image
    calls = []

    def fail_once(self, *args):
        calls.append(True)
        if len(calls) == 1:
            raise ProviderError("模型服务繁忙。", retryable=True)
        return original(self, *args)

    monkeypatch.setattr(ProviderHub, "image", fail_once)
    worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "queued" and job.attempts == 1 and job.error
        job.available_at = utcnow() - timedelta(seconds=1)
        session.commit()
    worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded" and job.attempts == 2 and job.error is None


def test_permanent_failure_is_visible_without_retry(local_db, monkeypatch):
    factory, ids = local_db
    job_id = add_job(factory, ids)

    def rejected(*args):
        raise ProviderError("模型服务返回 403（AllocationQuota.FreeTierOnly）。")

    monkeypatch.setattr(ProviderHub, "image", rejected)
    worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed" and job.attempts == 1
        assert "403" in job.error


def test_deleted_project_transient_failure_becomes_terminal(local_db, monkeypatch):
    factory, ids = local_db
    job_id = add_job(factory, ids)

    def deleted_during_call(*args):
        with factory() as session:
            project = session.get(Project, ids[1])
            project.deleted_at = utcnow()
            session.commit()
        raise ProviderError("暂时繁忙。", retryable=True)

    monkeypatch.setattr(ProviderHub, "image", deleted_during_call)
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed" and job.attempts == 1
        assert job.error == "项目已删除。"
        assert job.result_asset_id is None


def test_expired_lease_recovery_and_exhaustion(local_db):
    factory, ids = local_db
    stale = utcnow() - timedelta(seconds=worker.lease_seconds() + 1)
    recovered = add_job(factory, ids, status="running", attempts=1, locked_at=stale)
    failed = add_job(
        factory, ids, status="running", attempts=worker.max_attempts(), locked_at=stale
    )
    with factory() as session:
        job = worker.claim_job(session)
        assert job.id == recovered and job.attempts == 2
        assert session.get(Job, failed).status == "failed"
    # A stale first-attempt owner cannot publish a duplicate result.
    worker.process_job(recovered, 1, factory)
    with factory() as session:
        assert session.get(Job, recovered).status == "running"


def test_expired_unknown_paid_request_is_not_submitted_again(local_db):
    factory, ids = local_db
    job_id = add_job(
        factory,
        ids,
        status="running",
        attempts=1,
        locked_at=utcnow() - timedelta(seconds=worker.lease_seconds() + 1),
        result={"external_request_started": True},
    )
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "failed" and job.attempts == 1
        assert "避免重复计费" in job.error


def test_video_retry_resumes_saved_upstream_task(local_db, monkeypatch):
    factory, ids = local_db
    job_id = add_job(
        factory, ids, kind="video", payload={"source_asset_id": ids[2], "prompt": "转身"}
    )
    calls = []

    def fake_video(self, prompt, image, provider_task_id=None, on_submitted=None):
        calls.append(provider_task_id)
        if provider_task_id is None:
            on_submitted("upstream-123")
            raise ProviderError("视频仍在生成。", retryable=True)
        return GeneratedMedia(b"unit-video", "video/mp4", "unit-video-model")

    monkeypatch.setattr(ProviderHub, "video", fake_video)
    worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "queued" and job.payload["provider_task_id"] == "upstream-123"
        job.available_at = utcnow() - timedelta(seconds=1)
        session.commit()
    worker.run_once(factory)
    assert calls == [None, "upstream-123"]
    with factory() as session:
        assert session.get(Job, job_id).status == "succeeded"


@pytest.mark.parametrize("status,retryable", [(403, False), (422, False), (429, True), (503, True)])
def test_http_errors_are_sanitized(status, retryable):
    response = httpx.Response(status, json={"code": "Some.Code", "message": "private-url"})
    with pytest.raises(ProviderError) as raised:
        providers.ProviderHub._json(response)
    assert raised.value.retryable is retryable
    assert "private-url" not in str(raised.value)
