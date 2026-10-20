import io
import math
from datetime import timedelta

import pytest
from PIL import Image, ImageChops, ImageDraw
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import worker
from app.config import settings
from app.errors import AppError
from app.local_edit import compose_local_edit, crop_reference, prepare_selection
from app.media import asset_path, label_bounds, label_generated_image, store_generated
from app.models import Asset, Base, Job, Message, Project, User, utcnow
from app.providers import GeneratedMedia, ProviderError, ProviderHub
from app.views import image_items


def png(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def editbench(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    monkeypatch.setattr(settings, "mock_providers", True)
    settings.media_dir.mkdir()
    image = Image.new("RGB", (512, 768), "#8695b7")
    draw = ImageDraw.Draw(image)
    for offset in range(0, 512, 7):
        draw.line((offset, 0, 511 - offset, 767), fill=(offset % 256, 12, 215), width=2)
    (settings.media_dir / "source.png").write_bytes(label_generated_image(png(image), "initial"))
    engine = create_engine(f"sqlite:///{tmp_path / 'edits.sqlite'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        user = User(username="local-edit", password_hash="unused", nickname="local")
        session.add(user)
        session.flush()
        garment = Asset(
            user_id=user.id, kind="garment", path="source.png", mime="image/png",
            width=512, height=768, source="upload",
        )
        session.add(garment)
        session.flush()
        project = Project(
            user_id=user.id, title="局部编辑", brand="本地", brief="只改袖口",
            garment_asset_ids=[garment.id],
        )
        session.add(project)
        session.flush()
        source = Asset(
            user_id=user.id, project_id=project.id, kind="reference", path="source.png",
            mime="image/png", width=512, height=768, source="generated",
        )
        session.add(source)
        session.commit()
        ids = user.id, project.id, garment.id, source.id
    yield factory, ids
    engine.dispose()


@pytest.mark.parametrize("selection", [
    {"region": {"x": 0.2, "y": 0.3, "w": 0.15, "h": 0.12}},
    {"mask_strokes": {"brush": 0.05, "strokes": [
        [{"x": 0.1, "y": 0.4}, {"x": 0.4, "y": 0.6}], [{"x": 0.65, "y": 0.2}],
    ]}},
    {"region": {"x": 0, "y": 0, "w": 0.05, "h": 0.05}},
    {"region": {"x": 0.65, "y": 0.85, "w": 0.35, "h": 0.15}},
])
def test_local_composite_and_persist_change_zero_pixels_outside_mask(editbench, selection):
    factory, ids = editbench
    with factory() as session:
        source = session.get(Asset, ids[3])
        selected = prepare_selection((512, 768), **selection)
        cropped = crop_reference(source, selected)
        assert min(cropped.width, cropped.height) >= 240
        assert max(cropped.width, cropped.height) / min(cropped.width, cropped.height) <= 6
        edited = GeneratedMedia(png(Image.new("RGB", (300, 400), "red")), "image/png", "edit")
        result = compose_local_edit(source, edited, selected)
        saved = store_generated(
            session, user_id=ids[0], project_id=ids[1], kind="reference", media=result,
            parent_id=source.id, preserve_visible_label=True,
        )
        with Image.open(asset_path(source)) as original, Image.open(asset_path(saved)) as after:
            difference = ImageChops.difference(original.convert("RGB"), after.convert("RGB"))
            red, green, blue = difference.split()
            changed = ImageChops.lighter(ImageChops.lighter(red, green), blue).tobytes()
            selected_pixels = selected.mask.tobytes()
            assert sum(bool(value) for value in changed) > 16
            assert not any(
                changed and not mask
                for changed, mask in zip(changed, selected_pixels, strict=True)
            )
            assert after.info["AIGC"] == "AI生成"
            # The inherited visible label is not stamped again during save.
            assert after.getpixel((480, 750)) == original.getpixel((480, 750))
            assert ImageChops.difference(
                after.crop(label_bounds(after.size)), original.crop(label_bounds(original.size))
            ).getbbox() is None
        with (
            Image.open(io.BytesIO(result.data)) as before_save,
            Image.open(asset_path(saved)) as after,
        ):
            assert ImageChops.difference(before_save, after).getbbox() is None


@pytest.mark.parametrize("selection,reason", [
    ({"region": {"x": -0.1, "y": 0.1, "w": 0.2, "h": 0.2}}, "0 到 1"),
    ({"region": {"x": 0.9, "y": 0.1, "w": 0.2, "h": 0.2}}, "边界"),
    ({"region": {"x": 0.1, "y": math.nan, "w": 0.2, "h": 0.2}}, "有效数值"),
    ({"region": {"x": 0.1, "y": 0.1, "w": 0.001, "h": 0.001}}, "太小"),
    ({"mask_strokes": {"brush": 0.1, "strokes": []}}, "不能为空"),
    ({"mask_strokes": {"brush": 0.1, "strokes": [[]]}}, "不能为空"),
    ({"mask_strokes": {"brush": 0, "strokes": [[{"x": 0.5, "y": 0.5}]]}}, "大于 0"),
    ({"mask_strokes": {"brush": 0.01, "strokes": [[{"x": 1.1, "y": 0.5}]]}}, "0 到 1"),
    ({"mask_strokes": {"brush": 0.001, "strokes": [[{"x": 0.5, "y": 0.5}]]}}, "太小"),
])
def test_invalid_local_geometry_has_chinese_error(selection, reason):
    with pytest.raises(AppError, match=reason) as caught:
        prepare_selection((512, 768), **selection)
    assert caught.value.code == "INVALID_EDIT_REGION" and caught.value.status_code == 422


def enqueue_edit(factory, ids, **selection):
    user, project, garment, source = ids
    with factory() as session:
        job = Job(
            user_id=user, project_id=project, kind="edit", dedupe_key="edit-test",
            payload={
                "shot_id": "shot-1", "version": 2, "parent_id": "original-image",
                "parent_asset_id": source, "source_asset_id": source,
                "instruction": "袖口放下来", "prompt": "保留人物，只把袖口放下来",
                "reference_asset_ids": [source, garment], "garment_asset_ids": [garment],
                **selection,
            },
        )
        session.add(job)
        session.commit()
        return job.id


@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize("second_passes", [False, True])
def test_every_edit_compares_full_before_after_and_retries_once(
    editbench, monkeypatch, local, second_passes
):
    factory, ids = editbench
    generated, compared = [], []

    def image(self, prompt, references):
        generated.append((prompt, [item.id for item in references]))
        if local:
            assert references[-1].id not in ids
            assert references[0].id == ids[2]
            assert ids[3] not in [item.id for item in references]
            assert len(references) <= 3
            with Image.open(asset_path(references[-1])) as crop:
                assert min(crop.size) >= 240
                assert crop.size != (512, 768)
            assert "唯一待编辑的局部裁剪画布" in prompt
            assert "保持原短袖或长袖版型" in prompt
        return GeneratedMedia(png(Image.new("RGB", (240, 240), "red")), "image/png", "mock-edit")

    def check(self, before, after, instruction, region=None):
        compared.append((before.id, instruction, region))
        assert before.id == ids[3] and instruction == "袖口放下来"
        with Image.open(asset_path(after)) as result:
            assert result.size == ((512, 768) if local else (240, 240))
        return {
            "passed": len(compared) == 2 and second_passes,
            "reason": "袖口已放下" if len(compared) == 2 and second_passes else "袖口仍然卷起",
        }

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "check_edit", check)
    monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 92, "diffs": []})
    selection = {"region": {"x": 0.3, "y": 0.4, "w": 0.15, "h": 0.1}} if local else {}
    job_id = enqueue_edit(factory, ids, **selection)
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded"
        assert job.result["edit_check"]["passed"] is second_passes
        assert job.result["edit_retry_count"] == 1
        assert job.result["edit_image_request_count"] == 2
        assert len(generated) == len(compared) == 2
        assert "唯一一次纠正重试" in generated[1][0]
        assert len(session.scalars(select(Job)).all()) == 1
        projected = image_items(session, ids[1])[0]
        assert projected["edit_check"] == job.result["edit_check"]
        assert (projected["region"] is not None) is local
        messages = session.scalars(select(Message)).all()
        assert len(messages) == 1
        assert ("袖口仍然卷起" in messages[0].text) is not second_passes
    assert not list(settings.media_dir.glob(".edit-*"))


@pytest.mark.parametrize("selection", [
    {"region": {"x": 0.3, "y": 0.4, "w": 0.15, "h": 0.1}},
    {"mask_strokes": {"brush": 0.05, "strokes": [
        [{"x": 0.3, "y": 0.4}, {"x": 0.4, "y": 0.5}],
    ]}},
])
@pytest.mark.parametrize("retry", [False, True])
def test_local_anchor_keeps_all_garments_and_anchor_before_crop(
    editbench, monkeypatch, selection, retry,
):
    factory, ids = editbench
    with factory() as session:
        extra = [
            Asset(user_id=ids[0], kind="garment", path="source.png", mime="image/png")
            for _ in range(2)
        ]
        anchor = Asset(
            user_id=ids[0], project_id=ids[1], kind="reference", path="source.png",
            mime="image/png", source="generated",
        )
        session.add_all([*extra, anchor])
        session.flush()
        garments, anchor_asset_id = [ids[2], *[item.id for item in extra]], anchor.id
        session.add(Job(
            id="cover-image", project_id=ids[1], user_id=ids[0], kind="image",
            status="succeeded", result_asset_id=anchor.id, dedupe_key="cover-test",
            payload={"shot_id": "cover"},
        ))
        session.commit()
    job_id = enqueue_edit(
        factory, ids, **selection, garment_asset_ids=garments,
        reference_asset_ids=[ids[3], *garments, anchor_asset_id],
        anchor_asset_id=anchor_asset_id, anchor_id="cover-image",
        reference_style_prompt="参考风格：夜晚街头霓虹。",
    )
    generated, checks, inspections = [], [], []

    def image(self, prompt, references):
        reference_ids = [item.id for item in references]
        generated.append(reference_ids)
        assert reference_ids[:-1] == [*garments, anchor_asset_id]
        assert references[-1].id not in [*ids, *garments, anchor_asset_id]
        assert ids[3] not in reference_ids
        assert "最后一张参考图是唯一待编辑的局部裁剪画布" in prompt
        assert "倒数第二张是封面锚点" in prompt
        assert "同一人物身份、同一妆发与同一光线氛围" in prompt
        assert "不是编辑画布" in prompt and "不要输出全身照" in prompt
        assert "参考风格：夜晚街头霓虹。" in prompt
        with Image.open(asset_path(references[-1])) as cropped:
            return GeneratedMedia(
                png(Image.new("RGB", cropped.size, "red")), "image/png", "mock-edit"
            )

    def fidelity(self, originals, media, **identity):
        inspections.append(identity["anchor_asset"].id)
        assert [item.id for item in originals] == garments
        with Image.open(io.BytesIO(media.data)) as composed:
            assert composed.size == (512, 768)
        return {"score": 94, "diffs": [], "anchor_score": 93}

    def check(self, *args):
        checks.append(True)
        return {"passed": not retry or len(checks) == 2, "reason": "袖口已放下"}

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", fidelity)
    monkeypatch.setattr(ProviderHub, "check_edit", check)
    assert worker.run_once(factory)
    assert len(generated) == len(checks) == (2 if retry else 1)
    assert inspections == [anchor_asset_id] * len(generated)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded"
        assert job.result["edit_check"]["passed"] is True
        item = next(item for item in image_items(session, ids[1]) if item["id"] == job_id)
        assert item["anchor_id"] == "cover-image"
        assert item["fidelity"]["anchor_score"] == 93
    assert not list(settings.media_dir.glob(".edit-*"))


def test_fidelity_and_instruction_failures_share_one_retry_budget(editbench, monkeypatch):
    factory, ids = editbench
    calls = []

    def image(*args):
        calls.append(True)
        return GeneratedMedia(png(Image.new("RGB", (512, 768), "red")), "image/png", "edit")

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 42, "diffs": ["口袋缺失"]})
    monkeypatch.setattr(
        ProviderHub, "check_edit", lambda *args: {"passed": False, "reason": "袖口没有放下"}
    )
    job_id = enqueue_edit(factory, ids)
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert len(calls) == 2 and job.result["edit_retry_count"] == 1
        assert job.result["fidelity"]["auto_fixed"] is True
        assert "auto_fix_job_id" not in job.result
        assert len(session.scalars(select(Job)).all()) == 1


@pytest.mark.parametrize("retry_fails", [False, True])
def test_checker_outage_or_retry_failure_preserves_paid_image(editbench, monkeypatch, retry_fails):
    factory, ids = editbench
    calls = []

    def image(*args):
        calls.append(True)
        if retry_fails and len(calls) == 2:
            raise ProviderError("模型繁忙", retryable=True)
        return GeneratedMedia(png(Image.new("RGB", (512, 768), "red")), "image/png", "edit")

    def check(*args):
        if not retry_fails:
            raise ProviderError("视觉服务繁忙", retryable=True)
        return {"passed": False, "reason": "袖口仍然卷起"}

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "check_edit", check)
    monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 92, "diffs": []})
    job_id = enqueue_edit(factory, ids)
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded" and job.result_asset_id
        assert len(calls) == (2 if retry_fails else 1)
        assert job.result["edit_check"]["passed"] is False
        reason = "自动重试未完成" if retry_fails else "指令核对暂时无法完成"
        assert reason in job.result["edit_check"]["reason"]
        assert reason in session.scalar(select(Message)).text


@pytest.mark.parametrize("second_fails", [False, True])
def test_queue_retry_and_quality_retry_share_two_image_submissions(
    editbench, monkeypatch, second_fails
):
    factory, ids = editbench
    job_id = enqueue_edit(factory, ids)
    submissions = []

    def image(*args):
        with factory() as observed:
            # The counter is committed before invoking the provider, including
            # failed requests; a worker restart cannot erase this reservation.
            submissions.append(observed.get(Job, job_id).result["edit_image_request_count"])
        if len(submissions) == 1 or second_fails:
            raise ProviderError("模型服务繁忙。", retryable=True)
        return GeneratedMedia(png(Image.new("RGB", (512, 768), "red")), "image/png", "edit")

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "fidelity", lambda *args: {"score": 42, "diffs": ["口袋缺失"]})
    monkeypatch.setattr(
        ProviderHub, "check_edit", lambda *args: {"passed": False, "reason": "袖口仍然卷起"}
    )
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "queued" and job.result["edit_image_request_count"] == 1
        job.available_at = utcnow() - timedelta(seconds=1)
        session.commit()
    assert worker.run_once(factory)
    assert not worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert submissions == [1, 2] and job.result["edit_image_request_count"] == 2
        assert job.status == ("failed" if second_fails else "succeeded")
        assert "edit_retry_count" not in job.result
        if not second_fails:
            assert job.result["edit_check"] == {"passed": False, "reason": "袖口仍然卷起"}
            assert "袖口仍然卷起" in session.scalar(select(Message)).text
