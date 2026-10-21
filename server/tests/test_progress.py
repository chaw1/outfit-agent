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


def test_note_is_ready_after_user_approves_successful_subset():
    jobs = [job(1, "succeeded", script_hash="current"),
            job(2, "failed", script_hash="current")]
    progress = project_progress(project("note"), jobs)
    assert (progress["status"], progress["label"]) == ("ready", "笔记已就绪，等你看")


def test_successful_new_edit_supersedes_failed_attempt_for_same_shot():
    jobs = [job(1, "succeeded", script_hash="current", shot_id="shot-1"),
            job(2, "failed", "edit", script_hash="current", shot_id="shot-1", parent_id="1"),
            job(3, "succeeded", "edit", script_hash="current", shot_id="shot-1", parent_id="1")]
    progress = project_progress(project("images"), jobs)
    assert (progress["status"], progress["total"]) == ("waiting_you", 3)


def test_newest_failed_edit_is_reported_and_legacy_lineage_can_recover():
    jobs = [job(1, "succeeded", script_hash="current"),
            job(2, "failed", "edit", script_hash="current", parent_id="1")]
    assert project_progress(project("images"), jobs)["status"] == "failed"
    jobs.append(job(3, "succeeded", "edit", script_hash="current", parent_id="2"))
    assert project_progress(project("images"), jobs)["status"] == "waiting_you"


def test_later_edit_of_old_script_does_not_choose_current_image_batch():
    jobs = [job(1, "failed", script_hash="old", shot_id="shot-1"),
            job(2, "succeeded", script_hash="new", shot_id="shot-1"),
            job(3, "failed", "edit", script_hash="old", shot_id="shot-1", parent_id="1")]
    progress = project_progress(project("images"), jobs)
    assert (progress["status"], progress["total"]) == ("waiting_you", 1)


def test_partial_preview_failure_checks_entire_latest_group():
    jobs = [job(1, "failed", purpose="preview", preview_group="current"),
            job(2, "succeeded", purpose="preview", preview_group="current"),
            job(3, "succeeded", purpose="preview", preview_group="current")]
    progress = project_progress(project("direction"), jobs)
    assert (progress["status"], progress["label"], progress["total"]) == (
        "failed", "预览失败，点开看看", 3,
    )


def test_preview_group_ignores_old_failures_and_unrelated_later_job():
    jobs = [job(1, "failed", purpose="preview", preview_group="old"),
            job(2, "succeeded", purpose="preview", preview_group="current"),
            job(3, "succeeded", purpose="preview", preview_group="current"),
            job(4, "failed", "edit", script_hash="old")]
    progress = project_progress(project("direction"), jobs)
    assert (progress["status"], progress["running"], progress["total"]) == ("waiting_you", 0, 2)


def test_preview_counts_include_finished_jobs_and_ignore_old_active_group():
    jobs = [job(1, "queued", purpose="preview", preview_group="old"),
            job(2, "succeeded", purpose="preview", preview_group="current"),
            job(3, "running", purpose="preview", preview_group="current")]
    progress = project_progress(project("direction"), jobs)
    assert (progress["status"], progress["running"], progress["total"]) == ("generating", 1, 2)
    jobs[-1].status = "succeeded"
    assert project_progress(project("direction"), jobs)["status"] == "waiting_you"


def test_legacy_preview_fallback_is_bounded_to_latest_three():
    jobs = [job(1, "failed", purpose="preview"),
            *(job(index, "succeeded", purpose="preview") for index in range(2, 5))]
    progress = project_progress(project("direction"), jobs)
    assert (progress["status"], progress["total"]) == ("waiting_you", 3)


def test_edit_counts_include_terminal_jobs_in_related_batch():
    jobs = [job(1, "succeeded", "edit", script_hash="current"),
            job(2, "failed", "edit", script_hash="old"),
            job(3, "running", "edit", script_hash="current")]
    progress = project_progress(project("note"), jobs)
    assert (progress["label"], progress["running"], progress["total"]) == ("改图中", 1, 2)


def test_auto_fix_counts_include_whole_repair_group():
    jobs = [job(1, "succeeded", "edit", completion_batch_key="current"),
            job(2, "queued", "edit", completion_batch_key="current"),
            job(3, "failed", "edit", completion_batch_key="old")]
    progress = project_progress(project("images"), jobs)
    assert (progress["label"], progress["running"], progress["total"]) == ("改图中", 1, 2)


def test_video_counts_refer_only_to_current_video():
    jobs = [job(1, "failed", "video"), job(2, "running", "video")]
    progress = project_progress(project("video"), jobs)
    assert (progress["label"], progress["running"], progress["total"]) == ("视频生成中", 1, 1)


def test_public_list_includes_progress(api, project_assets):
    created, _, _ = project_assets
    listed = next(p for p in api.request("GET", "/api/projects") if p["id"] == created["id"])
    assert listed["progress"] == created["progress"]
    assert listed["progress"]["status"] == "idle"


def test_three_preview_group_counts_latest_attempt_for_each_variant():
    jobs = [job(i, "succeeded", purpose="preview", preview_group="current", preview_id=str(i))
            for i in range(1, 10)]
    jobs[4].status = "failed"
    jobs.append(job(10, "running", purpose="preview", preview_group="current", preview_id="5"))
    progress = project_progress(project("direction"), jobs)
    assert (progress["status"], progress["running"], progress["total"]) == ("generating", 1, 9)
    jobs[-1].status = "succeeded"
    assert project_progress(project("direction"), jobs)["status"] == "waiting_you"
