"""Build display traces from the exact durable accounting rows for a call scope."""

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.costs import points
from app.models import UsageLedger
from app.runtime_settings import default_runtime_settings, get_runtime_settings

LABELS = {
    "chat": "组织回复", "propose_directions": "提出方向", "write_script": "写脚本",
    "revise_script": "修改脚本", "restore_script": "恢复脚本", "write_note": "写笔记",
    "generate_images": "安排出图", "edit_image": "安排改图", "generate_video": "安排视频",
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
        "refs": list(refs), "steps": steps,
    }
