"""Cheap list projections from the existing stage and durable queue facts."""

from app.models import Job, Project


def _image_batch(job: Job):
    return job.payload.get("script_hash") or job.payload.get("script_version")


def _preview_group(jobs: list[Job]) -> list[Job]:
    previews = [job for job in jobs if job.payload.get("purpose") == "preview"]
    if not previews:
        return []
    latest = previews[-1]
    group = latest.payload.get("preview_group")
    if group:
        return list({job.payload.get("preview_id", job.id): job for job in previews
                     if job.payload.get("preview_group") == group}.values())
    # Older payloads have no durable batch identity. Bound this fallback to the
    # latest three ungrouped previews (the existing maximum direction count).
    return [job for job in previews if not job.payload.get("preview_group")][-3:]


def _edit_group(jobs: list[Job], latest: Job) -> list[Job]:
    edits = [job for job in jobs if job.kind == "edit"]
    batch = latest.payload.get("completion_batch_key")
    if batch:
        return [job for job in edits if job.payload.get("completion_batch_key") == batch]
    batch = _image_batch(latest)
    if batch is not None:
        return [job for job in edits if _image_batch(job) == batch
                and not job.payload.get("completion_batch_key")]
    parent = latest.payload.get("parent_id")
    return [job for job in edits if job.payload.get("parent_id") == parent] if parent else [latest]


def _current_images(jobs: list[Job]) -> list[Job]:
    images = [job for job in jobs if job.kind in {"image", "edit"}
              and job.payload.get("purpose") != "preview"]
    originals = [job for job in images if job.kind == "image"]
    if not originals:
        return images
    # An edit of an older script may be newer than the current script's images.
    # Only a newly queued original batch changes which script is current.
    batch = _image_batch(originals[-1])
    return [job for job in images if _image_batch(job) == batch]


def _latest_versions(images: list[Job]) -> list[Job]:
    identities, latest = {}, {}
    for job in images:
        parent = job.payload.get("parent_id")
        identity = job.payload.get("shot_id") or identities.get(parent) or job.id
        identities[job.id] = identity
        latest[identity] = job
    return list(latest.values())


def project_progress(project: Project, jobs: list[Job]) -> dict:
    jobs = sorted(jobs, key=lambda job: (job.created_at, job.id))
    updated_at = max([project.updated_at, *(job.updated_at for job in jobs)])

    def result(status, label, group=()):
        return {
            "status": status, "label": label,
            "running": sum(job.status in {"queued", "running"} for job in group),
            "total": len(group), "updated_at": updated_at.isoformat(),
        }

    previews = _preview_group(jobs)
    images = _current_images(jobs)
    current_ids = {job.id for job in [*previews, *images]}
    active = [job for job in jobs if job.status in {"queued", "running"}
              and (job.kind in {"edit", "video"} or job.id in current_ids)]
    if active:
        if any(job.kind == "video" for job in active):
            latest = next(job for job in reversed(active) if job.kind == "video")
            return result("generating", "视频生成中", [latest])
        if any(job.kind == "edit" for job in active):
            latest = next(job for job in reversed(active) if job.kind == "edit")
            return result("generating", "改图中", _edit_group(jobs, latest))
        formal = [j for j in active if j.payload.get("purpose") != "preview"]
        if formal:
            batch = _image_batch(formal[-1])
            group = [j for j in jobs if j.kind == "image"
                     and j.payload.get("purpose") != "preview"
                     and _image_batch(j) == batch]
            completed = sum(job.status == "succeeded" for job in group)
            return result("generating", f"出图中 {completed}/{len(group)}", group)
        return result("generating", "方向预览生成中", previews)

    if project.stage == "done":
        return result("done", "全套已出好")
    if project.stage == "script":
        return result("waiting_you", "等你确认脚本")
    if project.stage == "note":
        return result("ready", "笔记已就绪，等你看")
    if project.stage == "direction":
        if any(job.status == "failed" for job in previews):
            return result("failed", "预览失败，点开看看", previews)
        return result("waiting_you", "等你选择方向", previews)
    if project.stage == "video":
        videos = [job for job in jobs if job.kind == "video"]
        if videos and videos[-1].status == "succeeded":
            return result("done", "全套已出好", videos[-1:])
        if videos and videos[-1].status == "failed":
            return result("failed", "视频生成失败，点开看看", videos[-1:])
    if project.stage == "images":
        if any(job.status == "failed" for job in _latest_versions(images)):
            return result("failed", "出图失败，点开看看", images)
        return result("waiting_you", "图片已就绪，等你选图", images)
    return result("idle", "聊聊这次想拍什么")
