#!/usr/bin/env python3
"""Resumable direction-refresh evidence using Workflow and ProviderHub.

Run --mock for a local smoke check, or inject provider keys and pass --run for
one real selection and exactly two preview generations (hard cap 1.50 CNY).
A started call without a saved result is never submitted again automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.media import store_generated  # noqa: E402
from app.models import Asset, Base, Job, Project, UsageLedger, User  # noqa: E402
from app.providers import GeneratedMedia, ProviderHub  # noqa: E402
from app.workflow import Workflow  # noqa: E402

CAP = Decimal("1.50")
REFRESH = "换一组方向，保留我刚才说的偏好"
TURN_ID = "trace-real-direction-refresh-v1"
TEXT_ENDPOINT = "https://api.deepseek.com/chat/completions"
IMAGE_ENDPOINT = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
)


def write_json(path: Path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


class LimitedClient:
    """Permit official model endpoints and their Alibaba media downloads only."""

    def __init__(self, output: Path, step: str):
        self.output = output
        self.step = step

    def __enter__(self):
        self.client = httpx.Client(timeout=180, follow_redirects=False, trust_env=False)
        return self

    def __exit__(self, *args):
        self.client.close()

    def post(self, url, *, headers, **kwargs):
        if url not in {TEXT_ENDPOINT, IMAGE_ENDPOINT}:
            raise RuntimeError("Only official text/image endpoints are permitted")
        payload = kwargs["json"]
        expected_model = "deepseek-flash" if url == TEXT_ENDPOINT else "wan2.7-image-pro"
        if payload.get("model") != expected_model:
            raise RuntimeError("Unexpected model; refusing a paid call")
        if url == IMAGE_ENDPOINT and payload.get("parameters", {}).get("n") != 1:
            raise RuntimeError("Each preview request must generate exactly one image")
        response = self.client.post(url, headers=headers, **kwargs)
        self.record_diagnostics(response)
        return response

    @staticmethod
    def parse_diagnostic(value):
        try:
            return json.loads(value), {"succeeded": True}
        except json.JSONDecodeError as exc:
            return None, {"succeeded": False, "error_type": "JSONDecodeError",
                          "offset": exc.pos, "line": exc.lineno, "column": exc.colno}

    def record_diagnostics(self, response):
        """Store an explicit allowlist; never dump arbitrary bodies, headers or URLs."""
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in {"application/json", "text/plain", "text/html",
                                "text/event-stream", "application/octet-stream", ""}:
            content_type = "other"
        diagnostic = {"status": response.status_code, "content_type": content_type,
                      "body_characters": len(response.text)}
        try:
            parsed, diagnostic["json_parse"] = self.parse_diagnostic(response.text)
            if isinstance(parsed, dict):
                usage = parsed.get("usage") or {}
                if isinstance(usage, dict):
                    numeric_fields = {"prompt_tokens", "completion_tokens", "total_tokens",
                                      "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"}
                    diagnostic["usage"] = {
                        key: value for key, value in usage.items()
                        if key in numeric_fields and type(value) in {int, float}
                    }
                    details = usage.get("completion_tokens_details") or {}
                    if isinstance(details, dict) and type(details.get("reasoning_tokens")) is int:
                        diagnostic["usage"]["reasoning_tokens"] = details["reasoning_tokens"]
                choices = parsed.get("choices")
                if isinstance(choices, list):
                    diagnostic["choices"] = []
                    for choice in choices:
                        if not isinstance(choice, dict):
                            continue
                        reason = choice.get("finish_reason")
                        item = {"finish_reason": reason if reason in {
                            "stop", "length", "tool_calls", "content_filter", "function_call", None,
                        } else "other", "tool_calls": []}
                        message = choice.get("message") or {}
                        calls = message.get("tool_calls", []) if isinstance(message, dict) else []
                        for call in calls if isinstance(calls, list) else []:
                            function = call.get("function") if isinstance(call, dict) else None
                            if not isinstance(function, dict):
                                continue
                            name, arguments = function.get("name"), function.get("arguments")
                            known = name in {"propose_directions", "write_script", "chat"}
                            tool = {"name": name if known else "unknown"}
                            if isinstance(arguments, str):
                                tool["arguments_characters"] = len(arguments)
                                _, tool["arguments_json_parse"] = self.parse_diagnostic(arguments)
                                # Only expected direction content is reviewable raw text.
                                # Suppress it if URLs, credentials or signed fields appear.
                                unsafe = re.search(
                                    r"https?://|sk-[A-Za-z0-9]|Bearer\s|"
                                    r"(?i:authorization|api[_-]?key|password|secret|token|\"sig\")",
                                    arguments,
                                )
                                if name == "propose_directions" and not unsafe:
                                    tool["arguments"] = arguments
                                else:
                                    tool["arguments_omitted"] = True
                            item["tool_calls"].append(tool)
                        diagnostic["choices"].append(item)
        except Exception as exc:
            diagnostic["diagnostic_error_type"] = type(exc).__name__
        write_json(self.output / f"response-{self.step}.json", diagnostic)

    def stream(self, method, url, **kwargs):
        parsed = urlsplit(url)
        if (method != "GET" or parsed.scheme != "https"
                or not (parsed.hostname or "").endswith(".aliyuncs.com")):
            raise RuntimeError("Only provider-hosted HTTPS media downloads are permitted")
        # Never follow a media redirect into an unreviewed destination.
        return self.client.stream(method, url, **dict(kwargs, follow_redirects=False))


class EvidenceHub(ProviderHub):
    def __init__(self, session, project_id, journal, output):
        super().__init__(session, project_id)
        self.journal = journal
        self.output = output
        self.step = ""

    def _client(self):
        if self.mock:
            raise RuntimeError("Mock verification must not use HTTP")
        return LimitedClient(self.output, self.step)

    def _restore(self, value):
        if isinstance(value, dict) and value.get("media_file"):
            return GeneratedMedia(
                (self.output / value["media_file"]).read_bytes(), value["mime"], value["model"],
                value.get("width"), value.get("height"),
            )
        return value

    def _call(self, kind, estimate, operation):
        allowed = {"directions": "text", "preview-1": "image", "preview-2": "image",
                   "regenerate": "text"}
        if allowed.get(self.step) != kind:
            raise RuntimeError("Unexpected model call; no vision, third image or video permitted")
        self.journal.execute("BEGIN IMMEDIATE")
        existing = self.journal.execute(
            "SELECT * FROM calls WHERE step=?", (self.step,),
        ).fetchone()
        if existing:
            self.journal.rollback()
            if existing["status"] != "succeeded":
                raise RuntimeError(f"{self.step}: started/unknown call retained; no resubmission")
            self.ledger_ids.extend(json.loads(existing["ledger_ids"]))
            return self._restore(json.loads(existing["result"]))
        reservation = Decimal(estimate)
        spent = sum((Decimal(row[0] or row[1]) for row in self.journal.execute(
            "SELECT actual_cost,reservation FROM calls",
        )), Decimal(0))
        if spent + reservation > CAP:
            self.journal.rollback()
            raise RuntimeError("1.50 CNY hard cap reached; no further call submitted")
        self.journal.execute(
            "INSERT INTO calls(step,status,reservation,started_at) VALUES (?,'started',?,?)",
            (self.step, str(reservation), datetime.now(UTC).isoformat()),
        )
        self.journal.commit()
        self.write_evidence("running")
        previous_ids = set(self.ledger_ids)
        try:
            result = super()._call(kind, estimate, operation)
            if self.mock and self.step == "directions":
                # The deterministic fixture always offers three options; emulate
                # the real user's explicit two-option request for this smoke run.
                result = (result[0], dict(result[1], options=result[1]["options"][:2]))
            new_ids = [key for key in self.ledger_ids if key not in previous_ids]
            with Session(self._ledger_bind()) as accounting:
                rows = list(accounting.scalars(select(UsageLedger).where(
                    UsageLedger.id.in_(new_ids),
                )))
            if not rows or any(row.status != "succeeded" for row in rows):
                raise RuntimeError("Accounting incomplete; reservation retained without retry")
            actual = sum((row.estimated_cny for row in rows), Decimal(0))
            if actual > reservation:
                raise RuntimeError("Unexpected accounting cost above the reserved maximum")
            saved = result
            if isinstance(result, GeneratedMedia):
                media_file = f"{self.step}-raw.png"
                temporary = self.output / (media_file + ".tmp")
                temporary.write_bytes(result.data)
                temporary.replace(self.output / media_file)
                saved = {"media_file": media_file, "mime": result.mime, "model": result.model,
                         "width": result.width, "height": result.height}
            self.journal.execute(
                "UPDATE calls SET status='succeeded',actual_cost=?,result=?,ledger_ids=? "
                "WHERE step=?",
                (str(actual), json.dumps(saved, ensure_ascii=False),
                 json.dumps(new_ids), self.step),
            )
            self.journal.commit()
            return result
        except Exception as exc:
            self.journal.execute("UPDATE calls SET error_type=? WHERE step=?",
                                 (type(exc).__name__, self.step))
            self.journal.commit()
            raise
        finally:
            self.write_evidence("running")

    def write_evidence(self, status, **extra):
        calls = [dict(row) for row in self.journal.execute("SELECT * FROM calls ORDER BY rowid")]
        spent = sum((Decimal(row["actual_cost"] or row["reservation"]) for row in calls),
                    Decimal(0))
        for row in calls:
            for key in ("result", "ledger_ids"):
                row[key] = json.loads(row[key]) if row[key] else None
        with Session(self._ledger_bind()) as accounting:
            rows = list(accounting.scalars(select(UsageLedger).order_by(UsageLedger.created_at)))
            usage = [{"id": row.id, "model": row.model, "kind": row.kind,
                      "status": row.status, "duration_ms": row.duration_ms,
                      "cost_cny": str(row.estimated_cny), "units": row.units} for row in rows]
        path = self.output / "trace-real.json"
        previous = json.loads(path.read_text()) if path.exists() else {}
        write_json(path, {**previous, "status": status, "mode": "mock" if self.mock else "real",
                          "cap_cny": str(CAP), "cost_or_unknown_reservation_cny": str(spent),
                          "request": REFRESH, "calls": calls, "usage_ledger": usage, **extra})


def seed(session, output):
    project = session.scalar(select(Project).where(Project.title == "方向刷新真实验收"))
    if project:
        return project
    shutil.copyfile(ROOT / "fixtures" / "shirt.jpg", output / "media" / "shirt.jpg")
    user = User(username="trace-evidence", password_hash="unused", nickname="本地验收",
                profile={"style_notes": "不穿高跟鞋", "model_asset_ids": []})
    session.add(user)
    session.flush()
    with Image.open(output / "media" / "shirt.jpg") as image:
        garment = Asset(user_id=user.id, kind="garment", path="shirt.jpg", mime="image/jpeg",
                        width=image.width, height=image.height, source="upload")
    session.add(garment)
    session.flush()
    project = Project(user_id=user.id, title="方向刷新真实验收", brand="本地示例品牌",
                      brief="白衬衫工作日穿搭，每次只给两个通勤方向，生成两张方向预览。",
                      garment_asset_ids=[garment.id], stage="direction")
    session.add(project)
    session.commit()
    return project


def run(output: Path, *, mock: bool, regenerate: bool):
    output = output.resolve()
    if not output.is_relative_to(ROOT / "evidence"):
        raise RuntimeError("Evidence must remain under this server/evidence directory")
    if not mock and (not settings.deepseek_api_key or not settings.dashscope_api_key):
        raise RuntimeError("Inject both model keys into the process environment before --run")
    if (settings.deepseek_base_url.rstrip("/") != "https://api.deepseek.com"
            or settings.dashscope_base_url.rstrip("/") != "https://dashscope.aliyuncs.com/api/v1"):
        raise RuntimeError("Only official DeepSeek and DashScope base URLs are permitted")
    output.mkdir(parents=True, exist_ok=True)
    evidence_path = output / "trace-real.json"
    if evidence_path.exists():
        previous = json.loads(evidence_path.read_text())
        if previous.get("mode") != ("mock" if mock else "real"):
            raise RuntimeError("An existing evidence directory cannot change between real and mock")
    (output / "media").mkdir(exist_ok=True)
    settings.mock_providers = mock
    settings.media_dir = output / "media"
    settings.model_budget_cny = float(CAP)
    engine = create_engine(f"sqlite:///{output / 'business.sqlite'}")
    Base.metadata.create_all(engine)
    journal = sqlite3.connect(output / "calls.sqlite")
    journal.row_factory = sqlite3.Row
    journal.execute(
        "CREATE TABLE IF NOT EXISTS calls(step TEXT PRIMARY KEY,status TEXT NOT NULL,"
        "reservation TEXT NOT NULL,started_at TEXT NOT NULL,actual_cost TEXT,result TEXT,"
        "ledger_ids TEXT,error_type TEXT)",
    )
    journal.commit()
    try:
        with Session(engine, expire_on_commit=False) as session:
            project = seed(session, output)
            workflow = Workflow(session, project)
            hub = EvidenceHub(session, project.id, journal, output)
            workflow.providers = hub
            workflow.begin_turn({"turn_id": TURN_ID})
            # No vision call: this garment analysis and prior directions are seeded fixtures.
            old_options = ProviderHub._mock_text("propose_directions", {}, "")["options"][:2]
            state = {
                "stage": "direction", "directions": old_options, "images": [],
                "job_intents": [], "brief": {"original": project.brief},
                "garments": [{"asset_id": project.garment_asset_ids[0], "category": "衬衫",
                              "color": "白色", "material": "视觉待确认", "style_tags": ["简约"]}],
                "messages": [
                    {"role": "user", "content": "要通勤，每次只给两个方向，继续用平底鞋。"},
                    {"role": "assistant", "content": "记住了，用两个通勤方向继续探索。"},
                ],
            }
            hub.step = "directions"
            changed = workflow.handle(state, {"text": REFRESH, "turn_id": TURN_ID})
            session.commit()
            options = changed["directions"]
            if len(options) != 2 or changed["turn_trace"]["tool"] != "propose_directions":
                raise RuntimeError("Expected model-selected propose_directions with two options")
            for option in options:
                text = json.dumps(option, ensure_ascii=False)
                if not any(word in text for word in ("通勤", "写字楼", "办公", "工作日", "上班")):
                    raise RuntimeError("A refreshed direction did not retain commuting preference")
            if {item["scene"] for item in options} & {item["scene"] for item in old_options}:
                raise RuntimeError("Refresh reused an old scene")
            trace_cost = Decimal(str(changed["turn_trace"]["cost_cny"]))
            with Session(engine) as accounting:
                ledger_cost = sum((row.estimated_cny for row in accounting.scalars(
                    select(UsageLedger).where(UsageLedger.id.in_(hub.ledger_ids)),
                )), Decimal(0))
            if trace_cost != ledger_cost:
                raise RuntimeError("Dialogue trace cost differs from its exact accounting rows")
            hub.write_evidence("previews_pending", directions=options,
                               dialogue_trace=changed["turn_trace"], preference_checked=True,
                               trace_matches_ledger=True)
            previews = []
            for index, job_view in enumerate(changed["turn_jobs"], 1):
                if index > 2:
                    raise RuntimeError("Refusing a third preview")
                job = session.get(Job, job_view["id"])
                hub.step = f"preview-{index}"
                hub.ledger_ids = []
                hub.trace_context = {"job_id": job.id, "turn_id": TURN_ID}
                media = hub.image(job.payload["prompt"], [session.get(Asset, asset_id)
                                  for asset_id in job.payload["reference_asset_ids"]])
                if not job.result_asset_id:
                    asset = store_generated(session, user_id=project.user_id, project_id=project.id,
                                            kind="image", media=media, prompt=job.payload["prompt"])
                    job.result_asset_id = asset.id
                    job.status = "succeeded"
                    session.commit()
                asset = session.get(Asset, job.result_asset_id)
                with Session(engine) as accounting:
                    generation_rows = list(accounting.scalars(select(UsageLedger).where(
                        UsageLedger.id.in_(hub.ledger_ids),
                    )))
                generation = {
                    "model": media.model,
                    "duration_ms": sum(row.duration_ms for row in generation_rows),
                    "cost_cny": float(sum(
                        (row.estimated_cny for row in generation_rows), Decimal(0),
                    )),
                }
                previews.append({"job_id": job.id, "direction_id": job.payload["direction_id"],
                                 "asset_id": asset.id, "path": "media/" + asset.path,
                                 "sha256": hashlib.sha256(media.data).hexdigest(),
                                 "generation": generation})
                hub.write_evidence("previews_running", previews=previews)
            if len(previews) != 2 or len({item["sha256"] for item in previews}) != 2:
                raise RuntimeError("Expected two distinct newly generated previews")
            if regenerate:
                hub.step, hub.ledger_ids = "regenerate", []
                before = len(list(session.scalars(select(Job))))
                rewritten = hub.regenerate_reply(changed["turn_text"], {"directions": options})
                if len(list(session.scalars(select(Job)))) != before:
                    raise RuntimeError("Reply rewrite created a generation job")
                hub.write_evidence("running", rewritten_reply=rewritten,
                                   regeneration_created_no_jobs=True)
            hub.write_evidence("succeeded", previews=previews, no_vision_calls=True,
                               resumable_without_resubmission=True)
            print(f"Trace evidence saved: {output / 'trace-real.json'}")
    finally:
        journal.close()
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--run", action="store_true", help="Perform/resume real paid verification")
    mode.add_argument("--mock", action="store_true", help="Local verification without HTTP or keys")
    parser.add_argument("--regenerate", action="store_true",
                        help="Also verify text-only reply rewrite")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or ROOT / "evidence" / ("trace-mock" if args.mock else "trace-real")
    run(output, mock=args.mock, regenerate=args.regenerate)


if __name__ == "__main__":
    main()
