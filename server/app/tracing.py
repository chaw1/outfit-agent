"""Build display traces from the exact durable accounting rows for a call scope."""

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.costs import points
from app.media import signed_url
from app.models import Asset, Job, Project, UsageLedger
from app.runtime_settings import default_runtime_settings, get_runtime_settings

LABELS = {
    "chat": "组织回复", "propose_directions": "提出方向", "write_script": "写脚本",
    "revise_script": "修改脚本", "restore_script": "恢复脚本", "write_note": "写笔记",
    "generate_images": "安排出图", "edit_image": "安排改图", "generate_video": "安排视频",
    "background": "换背景", "outpaint": "扩图", "upscale": "高清",
}


def dialogue_trace(hub, tool: str, duration_ms: int, refs: list[str]) -> dict:
    ids = list(getattr(hub, "ledger_ids", []))
    rows = []
    if ids:
        with Session(hub._ledger_bind()) as session:
            rows = list(session.scalars(select(UsageLedger).where(
                UsageLedger.id.in_(ids),
            ).order_by(UsageLedger.created_at, UsageLedger.id)))
    text_models = [row.model for row in rows if row.kind == "text"]
    config = (get_runtime_settings(hub.session) if hasattr(hub, "session")
              else default_runtime_settings())
    model = text_models[-1] if text_models else config["models"]["text"]
    steps = [
        {"label": (f"看图 {row.units.get('images', 0)} 件" if row.kind == "vision"
                   else LABELS.get(tool, "重写回复")),
         "duration_ms": row.duration_ms}
        for row in rows
    ]
    if not steps:
        steps = [{"label": LABELS.get(tool, "重写回复"), "duration_ms": duration_ms}]
    return {
        "tool": tool, "model": model, "duration_ms": max(0, duration_ms),
        "cost_cny": float(sum((row.estimated_cny for row in rows), Decimal(0))),
        "cost_points": points(sum((row.estimated_cny for row in rows), Decimal(0))),
        "refs": list(refs), "steps": steps, "reference_images": [],
    }


def _visible_reference(asset: Asset | None, project: Project) -> bool:
    return bool(asset and asset.user_id == project.user_id and (
        asset.project_id in {None, project.id}
        or (asset.kind == "model" and asset.source == "generated")
    ))


def job_reference_images(session: Session, jobs: list[Job]) -> list[dict]:
    """Display durable inputs used by generation and its identity/clothing checks."""
    anchors = {job.payload.get("anchor_asset_id") for job in jobs}
    references = {}
    for job in jobs:
        project = session.get(Project, job.project_id)
        if project is None or job.user_id != project.user_id:
            continue
        payload = job.payload
        ids = list(payload.get("reference_asset_ids", []))
        if payload.get("purpose") != "preview" and job.kind in {"image", "edit"}:
            ids += payload.get("garment_asset_ids", project.garment_asset_ids)
            ids += [payload.get("model_asset_id", project.model_asset_id)]
        if job.kind == "edit":
            ids += [payload.get("source_asset_id") or payload.get("parent_asset_id")]
        ids += [payload.get("anchor_asset_id")]
        for asset_id in ids:
            if not asset_id or asset_id in references:
                continue
            asset = session.get(Asset, asset_id)
            if not _visible_reference(asset, project):
                continue
            role = ("封面锚点" if asset_id in anchors else "模特" if asset.kind == "model"
                    else "衣服" if asset.kind == "garment" else "参考图")
            references[asset_id] = {"id": asset_id, "url": signed_url(asset_id), "role": role}
    return list(references.values())


def refresh_trace(trace: dict | None, session: Session, project_id: str) -> dict | None:
    """History always re-signs owned input URLs rather than reusing expired links."""
    if trace is None:
        return None
    result = dict(trace)
    if "reference_images" not in trace:
        return result
    project = session.get(Project, project_id)
    result["reference_images"] = [
        {**item, "url": signed_url(item["id"])}
        for item in trace.get("reference_images") or []
        if project and _visible_reference(session.get(Asset, item["id"]), project)
    ]
    return result
