#!/usr/bin/env python3
"""Export accounting and timing evidence without credentials or signed URLs."""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.db import SessionLocal
    from app.models import UsageLedger

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id")
    parser.add_argument("--since", type=datetime.fromisoformat)
    parser.add_argument("--output", type=Path, default=Path("artifacts/usage.json"))
    args = parser.parse_args()
    statement = select(UsageLedger).order_by(UsageLedger.created_at)
    if args.project_id:
        statement = statement.where(UsageLedger.project_id == args.project_id)
    if args.since:
        statement = statement.where(UsageLedger.created_at >= args.since)
    grouped = defaultdict(lambda: {"calls": 0, "duration_ms": 0, "estimated_cny": Decimal(0)})
    calls = []
    with SessionLocal() as session:
        for row in session.scalars(statement):
            if row.units.get("mock"):
                continue
            group = grouped[row.model]
            group["calls"] += 1
            group["duration_ms"] += row.duration_ms
            group["estimated_cny"] += row.estimated_cny
            calls.append(
                {
                    "id": row.id,
                    "project_id": row.project_id,
                    "model": row.model,
                    "kind": row.kind,
                    "status": row.status,
                    "duration_ms": row.duration_ms,
                    "estimated_cny": str(row.estimated_cny),
                    "units": {
                        key: row.units[key]
                        for key in (
                            "prompt_tokens",
                            "completion_tokens",
                            "total_tokens",
                            "images",
                            "seconds",
                            "resolution",
                            "audio",
                            "reserved_cny",
                        )
                        if key in row.units
                    },
                    "created_at": row.created_at.isoformat(),
                }
            )
    result = {
        "notice": "保守价目估算，失败保留预留金额；最终扣费以供应商账单为准。",
        "total_calls": len(calls),
        "estimated_cny": str(sum((x["estimated_cny"] for x in grouped.values()), Decimal(0))),
        "models": dict(grouped),
        "calls": calls,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n")
    print(f"Usage evidence: {args.output} ({len(calls)} calls)")


if __name__ == "__main__":
    main()
