import io
from copy import deepcopy

import pytest
from PIL import Image
from pydantic import ValidationError
from sqlalchemy import select
from test_local_edit import editbench as editbench

from app import worker
from app.config import settings
from app.media import asset_path
from app.models import Asset, Job, Project
from app.providers import GeneratedMedia, ProviderHub
from app.quick_tools import (
    OUTPAINT_INSTRUCTION,
    UPSCALE_INSTRUCTION,
    outpaint_source,
    preset_action,
)
from app.schemas import EditImage
from app.views import image_items
from app.workflow import Workflow


def original_job(session, ids):
    parent = Job(
        id="quick-original", user_id=ids[0], project_id=ids[1], kind="image",
        status="succeeded", result_asset_id=ids[3], dedupe_key="quick-original",
        payload={"shot_id": "shot-1", "version": 1, "garment_asset_ids": [ids[2]]},
        result={"fidelity": {"score": 93, "diffs": [], "auto_fixed": False}},
    )
    session.add(parent)
    session.commit()
    return parent


@pytest.mark.parametrize("preset,instruction,extra,expected", [
    ("background", "海边傍晚", {}, "只换背景为 海边傍晚，人物、服装、姿势、光线方向保持不变"),
    ("outpaint", "任意文字", {"direction": "top"}, OUTPAINT_INSTRUCTION),
    ("upscale", "任意文字", {}, UPSCALE_INSTRUCTION),
])
def test_presets_enqueue_canonical_instruction_and_keep_version_chain(
    editbench, preset, instruction, extra, expected,
):
    factory, ids = editbench
    with factory() as session:
        parent = original_job(session, ids)
        workflow = Workflow(session, session.get(Project, ids[1]))
        state = {"stage": "images", "garments": [], "images": [], "job_intents": []}
        action = {"type": "edit_image", "image_id": parent.id, "preset": preset,
                  "instruction": instruction, "attempt": "same-attempt", **extra}
        workflow._edit_image(state, action, result={"reply": "原版保留"})
        job = session.scalars(select(Job).where(Job.kind == "edit")).one()
        assert job.payload["preset"] == preset
        assert job.payload["instruction"] == expected
        assert expected in job.payload["prompt"]
        assert job.payload["parent_id"] == parent.id and job.payload["version"] == 2
        assert state["turn_trace"]["tool"] == preset
        if preset == "outpaint":
            derived = session.get(Asset, job.payload["source_asset_id"])
            assert derived.parent_id == ids[3] and derived.id != ids[3]
            assert job.payload["reference_asset_ids"][0] == derived.id
        workflow._edit_image(state, action, result={"reply": "原版保留"})
        assert len(session.scalars(select(Job).where(Job.kind == "edit")).all()) == 1
        assert image_items(session, ids[1])[-1]["preset"] == preset


@pytest.mark.parametrize("direction,size,position", [
    ("top", (512, 960), (0, 192)), ("bottom", (512, 960), (0, 0)),
    ("horizontal", (768, 768), (128, 0)), ("all", (768, 1152), (128, 192)),
])
def test_outpaint_adds_white_edges_without_resampling_original(
    editbench, direction, size, position,
):
    factory, ids = editbench
    with factory() as session:
        source = session.get(Asset, ids[3])
        media = outpaint_source(source, direction)
        with Image.open(io.BytesIO(media.data)) as canvas, Image.open(asset_path(source)) as image:
            assert canvas.size == size
            x, y = position
            crop = canvas.crop((x, y, x + image.width, y + image.height))
            assert crop.tobytes() == image.tobytes()
            assert canvas.getpixel((0, 0) if direction != "bottom" else (0, size[1] - 1)) == (
                255, 255, 255,
            )


@pytest.mark.parametrize("upstream", ["unsupported", "supported", "wrong-size"])
def test_upscale_persists_exact_double_size_and_inherits_score(editbench, monkeypatch, upstream):
    factory, ids = editbench
    with factory() as session:
        parent = original_job(session, ids)
        original_score = deepcopy(parent.result["fidelity"])
        job = Job(
            user_id=ids[0], project_id=ids[1], kind="edit", dedupe_key="upscale-fallback",
            payload={"shot_id": "shot-1", "version": 2, "parent_id": parent.id,
                     "parent_asset_id": ids[3], "source_asset_id": ids[3], "preset": "upscale",
                     "instruction": UPSCALE_INSTRUCTION, "reference_asset_ids": [ids[3]]},
        )
        session.add(job)
        session.commit()
        job_id = job.id
    result = None
    if upstream != "unsupported":
        size = (1024, 1536) if upstream == "supported" else (768, 1024)
        output = io.BytesIO()
        Image.new("RGB", size, "white").save(output, "PNG")
        result = GeneratedMedia(output.getvalue(), "image/png", "mock-upscale", *size)
    monkeypatch.setattr(ProviderHub, "upscale", lambda *args: result)

    def forbidden(*args, **kwargs):
        pytest.fail("高清不应调用还原检查或指令核对")

    monkeypatch.setattr(ProviderHub, "fidelity", forbidden)
    monkeypatch.setattr(ProviderHub, "check_edit", forbidden)
    assert worker.run_once(factory)
    with factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded", job.error
        method = "provider_redraw" if upstream == "supported" else "pillow_lanczos"
        assert job.result["upscale_method"] == method
        assert job.result["edit_image_request_count"] == 1
        assert job.result["fidelity"] == original_score
        assert "edit_check" not in job.result
        with Image.open(asset_path(session.get(Asset, job.result_asset_id))) as image:
            assert image.size == (1024, 1536)
        assert image_items(session, ids[1])[-1]["upscale_method"] == method


def test_outpaint_checkpoint_can_restore_a_rolled_back_derived_reference(editbench):
    factory, ids = editbench
    with factory() as session:
        parent = original_job(session, ids)
        workflow = Workflow(session, session.get(Project, ids[1]))
        state = {"stage": "images", "garments": [], "images": [], "job_intents": []}
        workflow._edit_image(state, {
            "type": "edit_image", "image_id": parent.id, "instruction": "扩图",
            "preset": "outpaint", "direction": "all",
        }, result={"reply": "原版保留"})
        intent = deepcopy(state["job_intents"][-1])
        source_id = intent["payload"]["source_asset_id"]
        assert session.get(Asset, source_id)
        session.rollback()
        assert session.get(Asset, source_id) is None
        restored = workflow._restore_job(intent)
        assert restored.payload["source_asset_id"] == source_id
        assert session.get(Asset, source_id).parent_id == ids[3]


def test_upscale_adapter_uses_exact_size_only_when_supported(editbench, monkeypatch):
    factory, ids = editbench
    calls = []
    with factory() as session:
        hub = ProviderHub(session, ids[1])
        source = session.get(Asset, ids[3])
        monkeypatch.setattr(hub, "image", lambda prompt, refs, **kwargs: calls.append(kwargs))
        hub.upscale(UPSCALE_INSTRUCTION, source)
        assert calls == [{"output_size": (1024, 1536)}]
        monkeypatch.setattr(settings, "mock_providers", False)
        monkeypatch.setattr(hub, "_model", lambda kind: "wan2.7-image-pro")
        assert hub.upscale(UPSCALE_INSTRUCTION, source) is None
        assert len(calls) == 1


def test_preset_validation_and_replay_identity(editbench):
    base = {"type": "edit_image", "image_id": "original", "instruction": "扩图"}
    for extra in (
        {"preset": "unknown"}, {"preset": "outpaint", "direction": "left"},
        {"preset": "upscale", "direction": "all"},
        {"preset": "background", "region": {"x": 0, "y": 0, "w": 1, "h": 1}},
    ):
        with pytest.raises(ValidationError):
            EditImage.model_validate({**base, **extra})
    factory, ids = editbench
    with factory() as session:
        workflow = Workflow(session, session.get(Project, ids[1]))
        keys = {workflow._edit_key(preset_action({**base, "preset": "outpaint", "direction": d}))
                for d in ("top", "bottom", "horizontal", "all")}
        assert len(keys) == 4
