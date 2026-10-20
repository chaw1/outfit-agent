import json
from uuid import uuid4

import pytest

from scripts.e2e import API, Evidence, cards, complete, prepare, resume, safe


@pytest.mark.integration
@pytest.mark.parametrize("action", [
    {"type": "confirm_script"},
    {"type": "edit_image", "image_id": str(uuid4()), "instruction": "变亮"},
    {"type": "approve_images", "image_ids": [str(uuid4())]},
    {"type": "confirm_video", "image_id": str(uuid4())},
])
def test_expensive_actions_blocked_before_confirmation(api, project_assets, action):
    project, _, _ = project_assets
    project_id = project["id"]
    response = api.client.post(f"/api/projects/{project_id}/messages", json={"action": action})
    if response.status_code >= 400:
        assert "error" in response.json()
    else:
        assert "event: error" in response.text
    state = api.state(project_id)
    assert not state["active_jobs"] and not state["images"]
    assert not state.get("note") and not state.get("video")


@pytest.mark.integration
def test_invalid_direction_does_not_advance_or_queue(api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    api.send(project_id, text="夏季新品，想要松弛感")
    before = api.state(project_id)
    response = api.client.post(f"/api/projects/{project_id}/messages", json={"action": {
        "type": "choose_direction", "direction_id": str(uuid4()),
    }})
    assert response.status_code >= 400 or "event: error" in response.text
    after = api.state(project_id)
    assert after["stage"] == before["stage"] == "direction"
    assert not after.get("script") and not after["active_jobs"]


@pytest.mark.integration
def test_mock_end_to_end_and_job_owner_isolation(api, other_api, tmp_path, monkeypatch):
    username = f"resume_{uuid4().hex[:16]}"
    monkeypatch.setenv("E2E_USERNAME", username)
    monkeypatch.setenv("E2E_PASSWORD", f"test-{uuid4().hex}")
    evidence = Evidence(tmp_path / "e2e.json", "mock", str(api.client.base_url))
    project_id, state = prepare(api, evidence)
    state = complete(api, evidence, project_id, state, timeout=90)
    evidence.finish()
    video_job_id = state["video"]["job_id"]
    response = other_api.client.get(f"/api/jobs/{video_job_id}")
    assert response.status_code == 404 and "error" in response.json()
    recorded = json.dumps(json.loads((tmp_path / "e2e.json").read_text()))
    assert '"token":' not in recorded and "sig=" not in recorded
    history = safe(api.request("GET", f"/api/projects/{project_id}/messages"))
    previous_image_ids = [image["id"] for image in state["images"]]
    resumed_api = API(str(api.client.base_url))
    try:
        resumed_evidence = Evidence(
            tmp_path / "e2e.json", "mock", str(api.client.base_url), preserve_previous=True,
        )
        resumed = resume(resumed_api, resumed_evidence, project_id)
        resumed = complete(resumed_api, resumed_evidence, project_id, resumed, 90, resuming=True)
        resumed_evidence.finish()
        assert [image["id"] for image in resumed["images"]] == previous_image_ids
        assert resumed["video"]["job_id"] == video_job_id
        assert safe(resumed_api.request("GET", f"/api/projects/{project_id}/messages")) == history
        output = json.loads((tmp_path / "e2e.json").read_text())
        assert len(output["previous_runs"]) == 1
        assert output["username"] == username
    finally:
        resumed_api.close()


@pytest.mark.integration
def test_resume_images_reuses_confirmed_script_and_original_jobs(api, tmp_path, monkeypatch):
    monkeypatch.setenv("E2E_USERNAME", f"resume_{uuid4().hex[:16]}")
    monkeypatch.setenv("E2E_PASSWORD", f"test-{uuid4().hex}")
    evidence = Evidence(tmp_path / "resume-images.json", "mock", str(api.client.base_url))
    project_id, _ = prepare(api, evidence)
    api.send(project_id, text="换成通勤风")
    events = api.send(project_id, action={"type": "confirm_script"})
    original_ids = {event["data"]["id"] for event in events if event["event"] == "job"}
    state = api.state(project_id)
    confirmed_script = state["script"]
    assert state["stage"] == "images" and confirmed_script["status"] == "confirmed"
    resumed = resume(api, evidence, project_id)
    completed = complete(api, evidence, project_id, resumed, 90, resuming=True)
    assert completed["script"] == confirmed_script
    assert {i["id"] for i in completed["images"] if i["version"] == 1} == original_ids
    assert len(completed["images"]) == 5


@pytest.mark.integration
def test_stage_free_text_revises_script_without_generating(api, project_assets):
    project, _, _ = project_assets
    project_id = project["id"]
    api.send(project_id, text="夏季新品，想要松弛感")
    state = api.state(project_id)
    api.send(project_id, action={
        "type": "choose_direction", "direction_id": state["directions"][0]["id"],
    })
    before = api.state(project_id)
    events = api.send(project_id, text="换成通勤风")
    assert cards(events, "script")
    after = api.state(project_id)
    assert before["script"] != after["script"]
    assert after["stage"] == "script"
    assert after["pending_action"]["type"] == "confirm_script"
    assert not after["active_jobs"] and not after["images"]
