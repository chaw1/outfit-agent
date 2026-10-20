#!/usr/bin/env python3
"""Exactly two resumable text-only profile checks through the production adapter.

Inject DEEPSEEK_API_KEY into the process environment, then run with --run.
No keychain access, vision calls, image calls, credential files or automatic retries.
An interrupted/failed started call is retained at its full 0.05 CNY reservation;
rerunning refuses to submit that call again.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.models import Base, Project, User  # noqa: E402
from app.providers import ProviderHub  # noqa: E402
from app.workflow import Workflow  # noqa: E402

RESERVATION = Decimal("0.05")
TOTAL_CAP = Decimal("0.10")
MAX_TOKENS = 1400
ENDPOINT = "https://api.deepseek.com/chat/completions"
PREFERENCE = "喜欢松弛感，不穿高跟鞋；鞋子选择平底鞋"


class LimitedClient:
    def __enter__(self):
        self.client = httpx.Client(timeout=90, follow_redirects=False, trust_env=False)
        return self

    def __exit__(self, *args):
        self.client.close()

    def post(self, url, *, headers, **kwargs):
        if url != ENDPOINT:
            raise RuntimeError("Profile evidence permits only the official DeepSeek text endpoint")
        payload = dict(kwargs["json"], max_tokens=MAX_TOKENS)
        # Token count cannot exceed the UTF-8 bytes; include a message-envelope margin.
        byte_bound = len(json.dumps(payload, ensure_ascii=False).encode()) + 1024
        upper_cost = (Decimal(byte_bound) * Decimal("0.3")
                      + Decimal(MAX_TOKENS) * Decimal("1.2")) * Decimal("7.5") / 1_000_000
        if upper_cost > RESERVATION:
            raise RuntimeError("Conservative text cost bound exceeds the per-call reservation")
        return self.client.post(url, headers=headers, json=payload)


class EvidenceHub(ProviderHub):
    def __init__(self, session: Session, ledger: sqlite3.Connection, evidence_path: Path):
        super().__init__(session)
        self.ledger = ledger
        self.evidence_path = evidence_path
        self.step = ""

    @property
    def mock(self):
        return False

    def _client(self):
        return LimitedClient()

    def _model(self, kind):
        if kind != "text":
            raise RuntimeError("Profile evidence allows text only")
        return "deepseek-flash"

    def _call(self, kind, estimate, operation):
        if kind != "text" or self.step not in {"directions", "script"}:
            raise RuntimeError("Unexpected paid call")
        self.ledger.execute("BEGIN IMMEDIATE")
        existing = self.ledger.execute(
            "SELECT status,response FROM calls WHERE step=?", (self.step,)
        ).fetchone()
        if existing:
            self.ledger.rollback()
            if existing[0] != "succeeded":
                raise RuntimeError(
                    f"{self.step}: started/unknown call retained; refusing resubmission"
                )
            return tuple(json.loads(existing[1]))
        rows = self.ledger.execute("SELECT reservation FROM calls").fetchall()
        if sum((Decimal(row[0]) for row in rows), Decimal(0)) + RESERVATION > TOTAL_CAP:
            self.ledger.rollback()
            raise RuntimeError("Profile verification reached its 0.10 CNY reservation cap")
        self.ledger.execute(
            "INSERT INTO calls(step,status,reservation,started_at) VALUES (?,'started',?,?)",
            (self.step, str(RESERVATION), datetime.now(UTC).isoformat()),
        )
        self.ledger.commit()
        self.write_evidence()
        started = time.monotonic()
        try:
            result, usage, cost = operation()
            if cost is None or not usage.get("prompt_tokens"):
                raise RuntimeError("Usage unavailable; reservation retained")
            if cost > RESERVATION:
                raise RuntimeError("Unexpected cost above conservative reservation")
            self.ledger.execute(
                "UPDATE calls SET status='succeeded',cost=?,duration_ms=?,response=?,usage=? "
                "WHERE step=?",
                (str(cost), round((time.monotonic() - started) * 1000),
                 json.dumps(result, ensure_ascii=False), json.dumps(usage), self.step),
            )
            self.ledger.commit()
            return result
        except Exception as exc:
            self.ledger.execute("UPDATE calls SET error_type=? WHERE step=?",
                                (type(exc).__name__, self.step))
            self.ledger.commit()
            raise
        finally:
            self.write_evidence()

    def write_evidence(self):
        calls = [dict(row) for row in self.ledger.execute(
            "SELECT * FROM calls ORDER BY started_at"
        )]
        total = Decimal(0)
        for call in calls:
            total += Decimal(call["cost"] or call["reservation"])
            for field in ("response", "usage"):
                call[field] = json.loads(call[field]) if call[field] else None
        result = {
            "model": "deepseek-flash", "mode": "real-text-only", "preference": PREFERENCE,
            "calls": calls, "total_cost_or_unknown_reservation_cny": str(total),
            "cap_cny": str(TOTAL_CAP), "no_vision_or_image_calls": True,
        }
        temporary = self.evidence_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(self.evidence_path)


def run(output: Path):
    output = output.resolve()
    if not output.is_relative_to(ROOT):
        raise RuntimeError("Evidence must stay in this server worktree")
    if not settings.deepseek_api_key:
        raise RuntimeError("Inject DEEPSEEK_API_KEY into the environment before --run")
    if settings.deepseek_base_url.rstrip("/") != "https://api.deepseek.com":
        raise RuntimeError("Use the official DeepSeek endpoint")
    output.mkdir(parents=True, exist_ok=True)
    ledger = sqlite3.connect(output / "profile-ledger.sqlite")
    ledger.row_factory = sqlite3.Row
    ledger.execute(
        "CREATE TABLE IF NOT EXISTS calls (step TEXT PRIMARY KEY,status TEXT NOT NULL,"
        "reservation TEXT NOT NULL,started_at TEXT NOT NULL,cost TEXT,duration_ms INTEGER,"
        "response TEXT,usage TEXT,error_type TEXT)"
    )
    ledger.commit()
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            user = User(username="profile-evidence", password_hash="unused", nickname="偏好验收",
                        profile={"model_asset_ids": [], "style_notes": PREFERENCE,
                                 "height_cm": 168})
            session.add(user)
            session.flush()
            project = Project(user_id=user.id, title="偏好验证", brand="本地示例品牌",
                              brief="棉衬衫日常穿搭，三个镜头即可", garment_asset_ids=["garment-1"])
            session.add(project)
            session.flush()
            workflow = Workflow(session, project)
            hub = EvidenceHub(session, ledger, output / "profile-real.json")
            state = {"stage": "direction", "brief": project.brief, "garments": [{
                "asset_id": "garment-1", "category": "衬衫", "color": "白色",
                "material": "棉", "style_tags": ["日常"],
            }]}
            hub.step = "directions"
            directions = hub.text("propose_directions", workflow._context(state),
                                  "给出两个方向，照顾档案偏好，reply不超过50字。")
            state.update(directions=directions["options"],
                         chosen_direction_id=directions["options"][0]["id"])
            hub.step = "script"
            script = hub.text("write_script", workflow._context(state),
                              "按选定方向写三个精简镜头，照顾档案偏好，reply不超过50字。")
            # Keep automatic evidence intentionally narrow; a reviewer reads full
            # direction/script responses to judge whether the preference was met.
            for name, result in (("directions", directions), ("script", script)):
                text = json.dumps(result, ensure_ascii=False)
                if "平底" not in text or "松弛" not in text:
                    raise RuntimeError(
                        f"{name} response did not visibly reflect the saved preference"
                    )
            hub.write_evidence()
            print("Profile evidence saved; exactly two text calls, cap 0.10 CNY.")
    finally:
        ledger.close()
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Perform/resume the two real text calls")
    parser.add_argument("--output", type=Path, default=ROOT / "evidence" / "ops-profile")
    args = parser.parse_args()
    if not args.run:
        parser.error("Pass --run explicitly; the script performs up to two real paid text calls")
    run(args.output)


if __name__ == "__main__":
    main()
