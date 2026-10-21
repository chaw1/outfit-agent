"""Cheap list projections from the existing stage and durable queue facts."""

from app.models import Job, Project


def project_progress(project: Project, jobs: list[Job]) -> dict:
    jobs = sorted(jobs, key=lambda job: (job.created_at, job.id))
    updated_at = max([project.updated_at, *(job.updated_at for job in jobs)])

    def result(status, label, group=()):
        return {
            "status": status, "label": label,
            "running": sum(job.status in {"queued", "running"} for job in group),
            "total": len(group), "updated_at": updated_at.isoformat(),
        }

    active = [job for job in jobs if job.status in {"queued", "running"}]
    if active:
        if any(job.kind == "video" for job in active):
            return result("generating", "视频生成中", [j for j in active if j.kind == "video"])
        if any(job.kind == "edit" for job in active):
            return result("generating", "改图中", [j for j in active if j.kind == "edit"])
        formal = [j for j in active if j.payload.get("purpose") != "preview"]
        if formal:
            batch = formal[-1].payload.get("script_hash")
            group = [j for j in jobs if j.kind == "image"
                     and j.payload.get("purpose") != "preview"
                     and j.payload.get("script_hash") == batch]
            completed = sum(job.status == "succeeded" for job in group)
            return result("generating", f"出图中 {completed}/{len(group)}", group)
        return result("generating", "方向预览生成中", active)

    if project.stage == "done":
        return result("done", "全套已出好")
    if project.stage == "script":
        return result("waiting_you", "等你确认脚本")
    if project.stage == "direction":
        if jobs and jobs[-1].status == "failed":
            return result("failed", "预览失败，点开看看")
        return result("waiting_you", "等你选择方向")
    if project.stage == "video":
        videos = [job for job in jobs if job.kind == "video"]
        if videos and videos[-1].status == "succeeded":
            return result("done", "全套已出好", videos[-1:])
        if videos and videos[-1].status == "failed":
            return result("failed", "视频生成失败，点开看看", videos[-1:])
    if project.stage in {"images", "note"}:
        images = [j for j in jobs if j.kind in {"image", "edit"}
                  and j.payload.get("purpose") != "preview"]
        if images:
            latest = images[-1]
            batch = latest.payload.get("script_hash")
            group = [j for j in images if j.payload.get("script_hash") == batch]
            if any(j.status == "failed" for j in group):
                return result("failed", "出图失败，点开看看", group)
        if project.stage == "note":
            return result("ready", "笔记已就绪，等你看")
        return result("waiting_you", "图片已就绪，等你选图", images)
    return result("idle", "聊聊这次想拍什么")
