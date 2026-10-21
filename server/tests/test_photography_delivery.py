"""Queue photography instructions reach the image provider with fidelity intact."""

import pytest
import test_anchor_worker

from app import worker
from app.models import Job, Project

anchor_db = test_anchor_worker.anchor_db


@pytest.mark.parametrize("model", [True, False])
def test_photography_prompt_reaches_worker_without_losing_garments_or_cover(anchor_db, model):
    factory, calls, inspections = anchor_db
    project_id, ids, _ = test_anchor_worker.seed_batch(factory, model=model)
    with factory() as session:
        original_payloads = {job_id: dict(session.get(Job, job_id).payload) for job_id in ids}
        for payload in original_payloads.values():
            assert payload["photo_prompt"]
            assert payload["photo_prompt"] in payload["prompt"]

    assert worker.run_once(factory)
    assert calls[0]["job_id"] == ids[0]
    with factory() as session:
        cover_asset_id = session.get(Job, ids[0]).result_asset_id
        assert cover_asset_id
        project = session.get(Project, project_id)
        garment_ids = list(project.garment_asset_ids)
        expected_references = ([project.model_asset_id] if model else []) + garment_ids
    assert calls[0]["references"] == expected_references
    assert worker.run_once(factory)
    dependent = calls[-1]
    assert dependent["job_id"] in ids[1:]
    assert dependent["references"] == [*expected_references, cover_asset_id]
    assert "同一人、同一妆发与同一光线" in dependent["prompt"]
    assert "服装仍严格遵循原衣服参考图" in dependent["prompt"]
    assert inspections[-1]["anchor_asset"] == cover_asset_id

    clothing_protection = "严格保持原衣服版型、颜色、面料、纽扣、口袋、logo，不得增删或改变。"
    for call in calls:
        payload = original_payloads[call["job_id"]]
        assert payload["photo_prompt"] in call["prompt"]
        assert "不要棚拍白底" in call["prompt"]
        assert clothing_protection in call["prompt"]
    with factory() as session:
        job = session.get(Job, dependent["job_id"])
        assert job.status == "succeeded"
        assert job.payload["anchor_id"] == ids[0]
        assert job.payload["anchor_asset_id"] == cover_asset_id
        assert job.payload["garment_asset_ids"] == garment_ids
        assert job.payload["photo_prompt"] == original_payloads[job.id]["photo_prompt"]
