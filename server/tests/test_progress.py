from datetime import UTC, datetime, timedelta

import pytest

from app.models import Job, Project
from app.progress import project_progress

NOW = datetime.now(UTC)


def project(stage):
    return Project(id="project", stage=stage, updated_at=NOW)


def job(index, status, kind="image", **payload):
    return Job(id=str(index), kind=kind, status=status, payload=payload,
               created_at=NOW + timedelta(seconds=index),
               updated_at=NOW + timedelta(seconds=index))


def test_generating_counts_completed_shots_and_ignores_preview_and_old_batch():
    jobs = [job(1, "failed", script_hash="old"), job(2, "succeeded", purpose="preview"),
            job(3, "succeeded", script_hash="new"), job(4, "succeeded", script_hash="new"),
            job(5, "running", script_hash="new")]
    progress = project_progress(project("images"), jobs)
    assert progress == {
        "status": "generating", "label": "出图中 2/3", "running": 1, "total": 3,
        "updated_at": jobs[-1].updated_at.isoformat(),
    }


@pytest.mark.parametrize("stage,status,label", [
    ("brief", "idle", "聊聊这次想拍什么"),
    ("direction", "waiting_you", "等你选择方向"),
    ("script", "waiting_you", "等你确认脚本"),
    ("images", "waiting_you", "图片已就绪，等你选图"),
    ("note", "ready", "笔记已就绪，等你看"),
    ("done", "done", "全套已出好"),
])
def test_waiting_ready_and_done_labels(stage, status, label):
    progress = project_progress(project(stage), [])
    assert (progress["status"], progress["label"]) == (status, label)


@pytest.mark.parametrize("stage,jobs,status,label", [
    ("images", [job(1, "failed", script_hash="current")], "failed", "出图失败，点开看看"),
    ("images", [job(1, "queued", "edit")], "generating", "改图中"),
    ("video", [job(1, "running", "video")], "generating", "视频生成中"),
    ("video", [job(1, "succeeded", "video")], "done", "全套已出好"),
    ("video", [job(1, "failed", "video")], "failed", "视频生成失败，点开看看"),
])
def test_edits_videos_and_failures(stage, jobs, status, label):
    progress = project_progress(project(stage), jobs)
    assert (progress["status"], progress["label"]) == (status, label)


def test_public_list_includes_progress(api, project_assets):
    created, _, _ = project_assets
    listed = next(p for p in api.request("GET", "/api/projects") if p["id"] == created["id"])
    assert listed["progress"] == created["progress"]
    assert listed["progress"]["status"] == "idle"
