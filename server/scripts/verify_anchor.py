#!/usr/bin/env python3
"""Resumable reference-style A/B and three-shot anchor evidence, capped at 5 CNY.

Uses the production Workflow/Worker/ProviderHub against a private SQLite database.
The regular local API/Worker remain in Mock mode. Unknown calls are never repeated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageDraw
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import worker  # noqa: E402
from app.config import settings  # noqa: E402
from app.models import Asset, Base, Job, Message, Project, UsageLedger, User  # noqa: E402
from app.providers import GeneratedMedia, ProviderHub  # noqa: E402
from app.views import image_items  # noqa: E402
from app.workflow import Workflow  # noqa: E402
from scripts.verify_trace import LimitedClient, write_json  # noqa: E402

CAPS = {"R1": Decimal("2"), "R2": Decimal("2"), "total": Decimal("5")}
VISION_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
REQUEST = "白衬衫新品合作，请给两个适合这套衣服的拍摄方向，参考图仅借鉴场景与摄影风格。"


class OfficialClient(LimitedClient):
    def post(self, url, *, headers, **kwargs):
        if url != VISION_URL:
            return super().post(url, headers=headers, **kwargs)
        if kwargs["json"].get("model") != "qwen3-vl-plus":
            raise RuntimeError("Only the configured official vision model is permitted")
        response = self.client.post(url, headers=headers, **kwargs)
        self.record_diagnostics(response)
        return response


@contextmanager
def journal_at(output):
    journal = sqlite3.connect(output / "calls.sqlite", timeout=30)
    journal.row_factory = sqlite3.Row
    try:
        yield journal
    finally:
        journal.close()


def cost(rows):
    return sum((Decimal(row["actual_cost"] or row["reservation"]) for row in rows), Decimal(0))


class AnchorHub(ProviderHub):
    def __init__(
        self, session, project_id, *, output, label, group, trace_context=None, offline=False
    ):
        super().__init__(session, project_id, trace_context=trace_context)
        self.output, self.label, self.group = output, label, group
        self.offline = offline

    def _client(self):
        if self.mock:
            raise AssertionError("Mock evidence must not access the network")
        return OfficialClient(self.output, self.step.replace(":", "-"))

    def _call(self, kind, estimate, operation):
        caller = sys._getframe(1).f_code.co_name
        self.step = f"{self.label}:{kind}:{caller}"
        if kind not in {"text", "vision", "image"}:
            raise RuntimeError("Video calls are outside this verification")
        with journal_at(self.output) as journal:
            journal.execute("BEGIN IMMEDIATE")
            existing = journal.execute("SELECT * FROM calls WHERE step=?", (self.step,)).fetchone()
            if existing:
                journal.rollback()
                if existing["status"] != "succeeded":
                    raise RuntimeError(f"Unknown call {self.step}; refusing resubmission")
                self.ledger_ids.extend(json.loads(existing["ledger_ids"]))
                saved = json.loads(existing["result"])
                if isinstance(saved, dict) and "media_file" in saved:
                    return GeneratedMedia(
                        (self.output / saved["media_file"]).read_bytes(),
                        saved["mime"],
                        saved["model"],
                        saved["width"],
                        saved["height"],
                    )
                return saved
            if self.offline:
                journal.rollback()
                raise RuntimeError("Offline resume has no saved call; refusing new work")
            rows = journal.execute("SELECT * FROM calls").fetchall()
            reserve = Decimal(estimate)
            if (
                cost(rows) + reserve > CAPS["total"]
                or cost([row for row in rows if row["call_group"] == self.group]) + reserve
                > CAPS[self.group]
            ):
                journal.rollback()
                raise RuntimeError("Experiment budget reached; no request submitted")
            journal.execute(
                "INSERT INTO calls(step,call_group,status,reservation,started_at) "
                "VALUES (?,?,'started',?,?)",
                (self.step, self.group, str(reserve), datetime.now(UTC).isoformat()),
            )
            journal.commit()
        previous = set(self.ledger_ids)
        try:
            result = super()._call(kind, estimate, operation)
            keys = [key for key in self.ledger_ids if key not in previous]
            with Session(self._ledger_bind()) as accounting:
                rows = list(accounting.scalars(select(UsageLedger).where(UsageLedger.id.in_(keys))))
            if not rows or any(row.status != "succeeded" for row in rows):
                raise RuntimeError("Incomplete accounting; retaining reservation")
            actual = sum((row.estimated_cny for row in rows), Decimal(0))
            if actual > Decimal(estimate):
                raise RuntimeError("Actual cost exceeded reservation")
            saved = result
            if isinstance(result, GeneratedMedia):
                name = self.step.replace(":", "-") + "-raw.png"
                temporary = self.output / (name + ".tmp")
                temporary.write_bytes(result.data)
                temporary.replace(self.output / name)
                saved = {
                    "media_file": name,
                    "mime": result.mime,
                    "model": result.model,
                    "width": result.width,
                    "height": result.height,
                }
            with journal_at(self.output) as journal:
                journal.execute(
                    "UPDATE calls SET status='succeeded',actual_cost=?,result=?,ledger_ids=? "
                    "WHERE step=?",
                    (
                        str(actual),
                        json.dumps(saved, ensure_ascii=False),
                        json.dumps(keys),
                        self.step,
                    ),
                )
                journal.commit()
            return result
        except Exception as exc:
            with journal_at(self.output) as journal:
                journal.execute(
                    "UPDATE calls SET error_type=? WHERE step=?", (type(exc).__name__, self.step)
                )
                journal.commit()
            raise


def neon_fixture(path):
    """Original, deterministic lighting/scene reference; no external source imagery."""
    image = Image.new("RGB", (768, 1024), "#090e24")
    draw = ImageDraw.Draw(image)
    for x, y, w, h, color in [
        (0, 70, 240, 690, "#12152e"),
        (570, 35, 198, 730, "#17223b"),
        (240, 250, 140, 440, "#16203a"),
        (475, 180, 95, 530, "#0d142b"),
    ]:
        draw.rectangle((x, y, x + w, y + h), fill=color)
    draw.polygon([(0, 1024), (310, 640), (475, 640), (768, 1024)], fill="#151e37")
    for x, y, w, h, color in [
        (18, 190, 180, 70, "#fa36bb"),
        (610, 140, 95, 300, "#25dffc"),
        (205, 330, 60, 190, "#fe6d34"),
        (490, 400, 55, 150, "#fa36bb"),
    ]:
        draw.rectangle((x, y, x + w, y + h), outline=color, width=9)
        for yy in range(y + 15, y + h - 10, 25):
            draw.line((x + 12, yy, x + w - 12, yy), fill=color, width=4)
    for x, color in [(105, "#962363"), (630, "#15758a"), (380, "#a33665")]:
        for y in range(790, 1020, 24):
            width = (y - 690) // 4
            draw.line((x - width, y, x + width, y), fill=color, width=7)
    draw.line((384, 720, 384, 1024), fill="#a8a29c", width=4)
    image.save(path)


def seed(session, output):
    projects = list(session.scalars(select(Project).order_by(Project.title)))
    if projects:
        if len(projects) != 2:
            raise RuntimeError("Unexpected experiment database; refusing to add paid work")
        return projects
    user = User(username="anchor-evidence", password_hash="unused", nickname="本地验证")
    session.add(user)
    session.flush()
    assets = {}
    for name, kind in (("shirt", "garment"), ("model", "model")):
        shutil.copyfile(ROOT / "fixtures" / f"{name}.jpg", output / "media" / f"{name}.jpg")
        with Image.open(output / "media" / f"{name}.jpg") as image:
            asset = Asset(
                user_id=user.id,
                kind=kind,
                source="upload",
                path=f"{name}.jpg",
                mime="image/jpeg",
                width=image.width,
                height=image.height,
            )
        session.add(asset)
        session.flush()
        assets[kind] = asset.id
    neon_fixture(output / "media" / "neon-reference.png")
    reference = Asset(
        user_id=user.id,
        kind="reference",
        source="upload",
        path="neon-reference.png",
        mime="image/png",
        width=768,
        height=1024,
    )
    session.add(reference)
    session.flush()
    for name, refs in (("baseline", []), ("reference", [reference.id])):
        session.add(
            Project(
                user_id=user.id,
                title=name,
                brand="本地示例品牌",
                brief=REQUEST,
                garment_asset_ids=[assets["garment"]],
                model_asset_id=assets["model"],
                reference_asset_ids=refs,
            )
        )
    session.commit()
    return list(session.scalars(select(Project).order_by(Project.title)))


def snapshot(output, factory, **extra):
    path = output / "anchor-real.json"
    previous = json.loads(path.read_text()) if path.exists() else {}
    with journal_at(output) as journal:
        calls = [dict(row) for row in journal.execute("SELECT * FROM calls ORDER BY rowid")]
    for row in calls:
        row.pop("result", None)
        row["ledger_ids"] = json.loads(row["ledger_ids"]) if row["ledger_ids"] else []
    with factory() as session:
        usage = [
            {
                "id": row.id,
                "model": row.model,
                "kind": row.kind,
                "status": row.status,
                "duration_ms": row.duration_ms,
                "cost_cny": str(row.estimated_cny),
                "units": row.units,
            }
            for row in session.scalars(select(UsageLedger))
        ]
    write_json(
        path,
        {
            **previous,
            "mode": "mock" if settings.mock_providers else "real",
            "caps_cny": {k: str(v) for k, v in CAPS.items()},
            "calls": calls,
            "human_review": previous.get("human_review", "pending"),
            "usage_ledger": usage,
            "cost_or_unknown_reservation_cny": str(cost(calls)),
            "group_costs_cny": {
                group: str(cost([row for row in calls if row["call_group"] == group]))
                for group in ("R1", "R2")
            },
            **extra,
        },
    )


def contact_sheet(paths, output):
    images = []
    for path in paths:
        with Image.open(path) as source:
            image = source.convert("RGB")
            image.thumbnail((384, 512))
            images.append(image.copy())
    canvas = Image.new("RGB", (384 * len(images), 552), "white")
    draw = ImageDraw.Draw(canvas)
    for index, (image, path) in enumerate(zip(images, paths, strict=True)):
        canvas.paste(image, (index * 384, 32))
        draw.text((index * 384 + 8, 8), Path(path).stem[:45], fill="black")
    canvas.save(output)


def run(output, *, mock, offline):
    output = output.resolve()
    if not output.is_relative_to(ROOT / "evidence"):
        raise RuntimeError("Evidence must stay in this worktree's server/evidence directory")
    if not mock and output != ROOT / "evidence" / "anchor-real":
        raise RuntimeError(
            "Real verification must reuse evidence/anchor-real; no alternate journal"
        )
    if (
        settings.deepseek_base_url.rstrip("/") != "https://api.deepseek.com"
        or settings.dashscope_base_url.rstrip("/") != "https://dashscope.aliyuncs.com/api/v1"
        or settings.dashscope_compatible_url.rstrip("/")
        != VISION_URL.removesuffix("/chat/completions")
    ):
        raise RuntimeError("Only official model endpoints are permitted")
    if (
        not mock
        and not offline
        and (not settings.deepseek_api_key or not settings.dashscope_api_key)
    ):
        raise RuntimeError("Inject both personal model keys into this process")
    output.mkdir(parents=True, exist_ok=True)
    pair = [(output / name).exists() for name in ("calls.sqlite", "business.sqlite")]
    if any(pair) and not all(pair):
        raise RuntimeError("Experiment journal/database pair incomplete; do not recreate")
    config = {
        "mode": "mock" if mock else "real",
        "request": REQUEST,
        "version": 1,
        "fixtures": {
            name: hashlib.sha256((ROOT / "fixtures" / name).read_bytes()).hexdigest()
            for name in ("shirt.jpg", "model.jpg")
        },
    }
    config_path = output / "config.json"
    if config_path.exists() and json.loads(config_path.read_text()) != config:
        raise RuntimeError("Experiment configuration changed; refusing to mix results")
    if offline and not all(pair):
        raise RuntimeError("Offline resume requires existing results")
    write_json(config_path, config)
    settings.mock_providers, settings.media_dir, settings.model_budget_cny = (
        mock,
        output / "media",
        5,
    )
    settings.media_dir.mkdir(exist_ok=True)
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    factory = sessionmaker(engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with journal_at(output) as journal:
        journal.execute(
            "CREATE TABLE IF NOT EXISTS calls("
            "step TEXT PRIMARY KEY,call_group TEXT,status TEXT,reservation TEXT,"
            "started_at TEXT,actual_cost TEXT,result TEXT,ledger_ids TEXT,error_type TEXT)"
        )
        journal.commit()
    original_hub, original_client = worker.ProviderHub, AnchorHub._client
    if offline:

        def forbidden(self):
            raise AssertionError("Offline resume attempted a network call")

        AnchorHub._client = forbidden
    try:
        states, preview_paths = {}, []
        with factory() as session:
            projects = seed(session, output)
            for project in projects:
                workflow = Workflow(session, project)
                workflow.providers = AnchorHub(
                    session,
                    project.id,
                    output=output,
                    label=f"r1-{project.title}",
                    group="R1",
                    offline=offline,
                )
                state = workflow.start({"text": REQUEST, "turn_id": f"r1-{project.title}"})
                session.commit()
                if len(state["directions"]) < 2:
                    raise RuntimeError("Expected at least two model-selected directions")
                states[project.title] = state
                # Exactly one actual preview per branch, the other queued previews are not run.
                preview = session.get(Job, state["turn_jobs"][0]["id"])
                workflow.providers.label = f"r1-preview-{project.title}"
                if preview.status != "succeeded":
                    assets = [
                        session.get(Asset, key) for key in preview.payload["reference_asset_ids"]
                    ]
                    media = workflow.providers.image(preview.payload["prompt"], assets)
                    from app.media import store_generated

                    asset = store_generated(
                        session,
                        user_id=project.user_id,
                        project_id=project.id,
                        kind="reference",
                        media=media,
                        prompt=preview.payload["prompt"],
                    )
                    preview.result_asset_id, preview.status = asset.id, "succeeded"
                    session.commit()
                preview_paths.append(
                    output / "media" / session.get(Asset, preview.result_asset_id).path
                )
                snapshot(
                    output,
                    factory,
                    status="R1_running",
                    directions={name: value["directions"] for name, value in states.items()},
                    reference_analysis=states.get("reference", {}).get("references", []),
                )
            reference_project = next(
                project for project in projects if project.title == "reference"
            )
            state = states["reference"]
            workflow = Workflow(session, reference_project)
            workflow.providers = AnchorHub(
                session,
                reference_project.id,
                output=output,
                label="r2-script",
                group="R2",
                offline=offline,
            )
            workflow.begin_turn({"turn_id": "r2-script"})
            state = workflow.handle(
                state,
                {
                    "action": {
                        "type": "choose_direction",
                        "direction_id": state["directions"][0]["id"],
                    }
                },
            )
            # The real experiment requests only three shots to keep the acceptance budget bounded.
            state["script"]["shots"] = state["script"]["shots"][:3]
            session.commit()
            workflow.providers.label = "r2-confirm"
            workflow.begin_turn({"turn_id": "r2-confirm"})
            state = workflow.handle(state, {"action": {"type": "confirm_script"}})
            session.commit()
            job_ids = [item["id"] for item in state["turn_jobs"]]
            # Leave unused R1 preview intents intact, but terminal for this queue run.
            for preview in session.scalars(select(Job).where(Job.status == "queued")):
                if preview.payload.get("purpose") == "preview":
                    preview.status, preview.error = "failed", "验证只运行每组首张预览"
            session.commit()
            project_id = reference_project.id
        contact_sheet(
            [output / "media" / "neon-reference.png", *preview_paths],
            output / "reference-comparison.png",
        )
        worker.ProviderHub = lambda session, project_id, **kwargs: AnchorHub(
            session,
            project_id,
            output=output,
            label=f"r2-job-{kwargs['trace_context']['job_id']}",
            group="R2",
            offline=offline,
            **kwargs,
        )
        # One production claim/process cycle at a time keeps conservative vision reservations
        # below the 2-CNY R2 cap; independent workers/parallel readiness are tested under Mock.
        order = []
        for _ in range(10):
            with factory() as session:
                job = worker.claim_job(session)
                if job is None:
                    break
                key, attempt = job.id, job.attempts
                order.append({"id": key, "payload": job.payload})
            worker.process_job(key, attempt, factory)
            snapshot(output, factory, status="R2_running", claim_order=order)
        with factory() as session:
            items = image_items(session, project_id)
            jobs = [session.get(Job, key) for key in job_ids]
            if len(jobs) != 3 or any(job.status != "succeeded" for job in jobs):
                raise RuntimeError("Three-shot run incomplete; inspect saved jobs before resuming")
            for job in jobs:
                if "person_score" not in job.result.get("fidelity", {}):
                    raise RuntimeError("Missing vision person score")
            for job in jobs[1:]:
                if not job.payload.get("anchor_id") or "anchor_score" not in job.result["fidelity"]:
                    raise RuntimeError("Missing anchor reference or vision score")
            final_paths = [
                output / "media" / session.get(Asset, job.result_asset_id).path for job in jobs
            ]
            messages = [
                {"text": row.text, "trace": row.trace}
                for row in session.scalars(select(Message).where(Message.project_id == project_id))
            ]
            payloads = [
                {"id": job.id, "payload": job.payload, "result": job.result} for job in jobs
            ]
        contact_sheet(final_paths, output / "anchor-three-shots.png")
        snapshot(
            output,
            factory,
            status="succeeded",
            images=items,
            jobs=payloads,
            messages=messages,
            script=state["script"],
            comparison="reference-comparison.png",
            anchor_sheet="anchor-three-shots.png",
            offline_resume=offline,
        )
    except Exception as exc:
        snapshot(output, factory, status="stopped", error_type=type(exc).__name__)
        raise
    finally:
        worker.ProviderHub, AnchorHub._client = original_hub, original_client
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mock == args.run:
        parser.error("Select exactly one of --mock or --run")
    output = args.output or ROOT / "evidence" / ("anchor-mock" if args.mock else "anchor-real")
    run(output, mock=args.mock, offline=args.offline)
    print(json.dumps({"status": "succeeded", "evidence": str(output / "anchor-real.json")}))


if __name__ == "__main__":
    main()
