#!/usr/bin/env python3
"""Exercise the public contract over HTTP; works with Mock and real providers.

Run from server/: uv run python scripts/e2e.py --mode mock
Only explicit --mode real permits a server reporting real providers.
Evidence intentionally omits authentication tokens and media URL signatures.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"


def safe(value: Any) -> Any:
    """Keep reviewable evidence without bearer credentials or signed capabilities."""
    if isinstance(value, dict):
        return {
            k: safe(v)
            for k, v in value.items()
            if k.lower() not in {"token", "password", "authorization", "sig", "secret"}
        }
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        parsed = urlsplit(value)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    return value


class Evidence:
    def __init__(self, path: Path, mode: str, base_url: str, *, preserve_previous=False):
        self.path = path
        previous = None
        if preserve_previous and path.is_file():
            previous = json.loads(path.read_text())
        self.data: dict[str, Any] = {
            "started_at": datetime.now(UTC).isoformat(),
            "mode": mode,
            "base_url": base_url,
            "status": "running",
            "steps": [],
        }
        if previous:
            runs = previous.pop("previous_runs", [])
            self.data["previous_runs"] = [*runs, previous]
        self.write()

    def write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(safe(self.data), ensure_ascii=False, indent=2) + "\n")
        tmp.replace(self.path)

    @contextmanager
    def step(self, name: str):
        entry = {"name": name, "started_at": datetime.now(UTC).isoformat()}
        self.data["steps"].append(entry)
        started = time.monotonic()
        try:
            yield entry
            entry["status"] = "passed"
        except BaseException as exc:
            entry["status"] = "failed"
            # Responses may contain signed URLs, so record only exception type.
            entry["error_type"] = type(exc).__name__
            self.data["status"] = "failed"
            raise
        finally:
            entry["duration_s"] = round(time.monotonic() - started, 3)
            self.write()

    def finish(self, **details):
        self.data.update(status="passed", finished_at=datetime.now(UTC).isoformat(), **details)
        self.write()


class API:
    def __init__(self, base_url="http://127.0.0.1:18080", timeout=180):
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout, trust_env=False,
        )

    def close(self):
        self.client.close()

    def request(self, method: str, path: str, **kwargs):
        response = self.client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    def register(self, prefix="e2e", *, credentials=None, allow_existing=False):
        credentials = credentials or {
            "username": f"{prefix}_{uuid.uuid4().hex[:16]}",
            "password": f"verify-{uuid.uuid4().hex}",
        }
        response = self.client.post("/api/auth/register", json=credentials)
        if response.status_code == 409 and allow_existing:
            result = self.request("POST", "/api/auth/login", json=credentials)
        else:
            response.raise_for_status()
            result = response.json()
        self.client.headers["Authorization"] = f"Bearer {result['token']}"
        return credentials, result["user"]

    def upload(self, filename: str, kind: str):
        with (FIXTURES / filename).open("rb") as file:
            return self.request(
                "POST", "/api/assets", files={"file": (filename, file, "image/jpeg")},
                data={"kind": kind},
            )

    def send(self, project_id: str, *, text=None, action=None, refs=None):
        payload = {}
        if text is not None:
            payload["text"] = text
        if action is not None:
            payload["action"] = action
        if refs is not None:
            payload["refs"] = refs
        events = []
        event_name = "message"
        data_lines: list[str] = []
        with self.client.stream(
            "POST", f"/api/projects/{project_id}/messages", json=payload,
        ) as response:
            response.raise_for_status()
            assert "text/event-stream" in response.headers.get("content-type", "")
            for line in response.iter_lines():
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                elif not line and data_lines:
                    event = {"event": event_name, "data": json.loads("\n".join(data_lines))}
                    events.append(event)
                    data_lines = []
                    event_name = "message"
        assert events and events[-1]["event"] == "done", "SSE must terminate with done"
        errors = [event["data"] for event in events if event["event"] == "error"]
        assert not errors, f"SSE error codes: {[error.get('code') for error in errors]}"
        assert all(event["event"] in {"token", "card", "job", "trace", "done"} for event in events)
        return events

    def state(self, project_id):
        return self.request("GET", f"/api/projects/{project_id}/state")

    def wait(self, project_id, predicate, *, timeout=600, poll=1):
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            state = self.state(project_id)
            jobs = state.get("active_jobs", [])
            failures = [job for job in jobs if job["status"] == "failed"]
            assert not failures, f"Failed job ids: {[job['id'] for job in failures]}"
            assert not any(image["status"] == "failed" for image in state.get("images", [])), (
                "An image job failed; inspect its sanitized job error"
            )
            assert (state.get("video") or {}).get("status") != "failed", "Video job failed"
            if predicate(state):
                return state
            time.sleep(poll)
        raise TimeoutError(f"Project {project_id} did not finish within {timeout}s")


def cards(events, kind):
    return [e["data"] for e in events if e["event"] == "card" and e["data"]["type"] == kind]


def script_hash(script):
    return hashlib.sha256(json.dumps(script, sort_keys=True).encode()).hexdigest()


def assert_preview_jobs_only(state):
    """Pre-confirmation jobs may only be the new direction previews."""
    assert not state["images"], "Batch images must wait for script confirmation"
    pending_previews = 0
    for direction in state["directions"]:
        previews = direction.get("previews") or []
        if previews:
            pending_previews += sum(p.get("status") in {"queued", "running"} for p in previews)
        elif direction.get("preview_status") in {"queued", "running"}:
            pending_previews += 1
    assert len(state["active_jobs"]) == pending_previews
    assert all(job["kind"] == "image" for job in state["active_jobs"])


def environment_credentials(*, required=False):
    username = os.environ.get("E2E_USERNAME")
    password = os.environ.get("E2E_PASSWORD")
    if bool(username) != bool(password) or (required and not username):
        raise ValueError("E2E_USERNAME and E2E_PASSWORD must both be set for resume")
    return {"username": username, "password": password} if username else None


def verify_health(api, evidence):
    with evidence.step("health") as step:
        health = api.request("GET", "/api/health")
        assert health["ok"] is True
        assert health["providers"]["mock"] is (evidence.data["mode"] == "mock"), (
            "Provider mode mismatch"
        )
        step["providers"] = health["providers"]


def advance_to_script(api, evidence, project_id, state):
    if state["stage"] == "brief":
        with evidence.step("garments_and_directions") as step:
            events = api.send(project_id, text="夏季新品，想要松弛感")
            assert cards(events, "garments") and cards(events, "directions")
            state = api.state(project_id)
            assert 2 <= len(state["directions"]) <= 3
            assert state["pending_action"]["type"] == "choose_direction"
            assert_preview_jobs_only(state)
            step["directions"] = state["directions"]
    if state["stage"] == "direction":
        with evidence.step("direction_previews") as step:
            state = api.wait(project_id, lambda s: not s["active_jobs"])
            assert all(d.get("preview_status") in {"succeeded", "failed"}
                       for d in state["directions"]), "Every direction must have a terminal preview"
            succeeded = [d for d in state["directions"] if d.get("preview_status") == "succeeded"]
            assert succeeded and all(d.get("preview_url") for d in succeeded)
            if evidence.data["mode"] == "mock":
                assert len(succeeded) == len(state["directions"])
            step["preview_count"] = len(state["directions"])
            step["succeeded"] = len(succeeded)
            step["failed"] = len(state["directions"]) - len(succeeded)
        with evidence.step("choose_direction_and_script") as step:
            direction_id = state["directions"][0]["id"]
            events = api.send(project_id, action={
                "type": "choose_direction", "direction_id": direction_id,
            })
            assert cards(events, "script")
            state = api.state(project_id)
            script = state["script"]
            assert script["status"] == "draft" and len(script["shots"]) >= 4
            garment_ids = {a["asset_id"] for a in state["garments"]}
            assert all(set(s["outfit_asset_ids"]) <= garment_ids for s in script["shots"])
            assert all(shot["outfit_asset_ids"] for shot in script["shots"])
            assert state["pending_action"]["type"] == "confirm_script"
            assert not state["active_jobs"] and not state["images"]
            step["script"] = script
    return state


def prepare(api: API, evidence: Evidence):
    verify_health(api, evidence)
    with evidence.step("register") as step:
        credentials, user = api.register(
            credentials=environment_credentials(), allow_existing=True,
        )
        step["user_id"] = user["id"]
        evidence.data["username"] = user["username"]
    with evidence.step("login"):
        login = api.request("POST", "/api/auth/login", json=credentials)
        assert login["user"]["id"] == user["id"]
        api.client.headers["Authorization"] = f"Bearer {login['token']}"
        assert api.request("GET", "/api/me")["id"] == user["id"]
    with evidence.step("upload_two_garments_and_model") as step:
        garments = [api.upload(name, "garment") for name in ("shirt.jpg", "jeans.jpg")]
        model = api.upload("model.jpg", "model")
        step["asset_ids"] = [a["id"] for a in [*garments, model]]
        for asset in [*garments, model]:
            response = api.client.get(asset["url"])
            assert response.status_code == 200 and response.content
    with evidence.step("create_project") as step:
        project = api.request("POST", "/api/projects", json={
            "title": "夏季新品合作验证", "brand": "本地验证品牌",
            "brief": "夏季新品，想要松弛感",
            "garment_asset_ids": [a["id"] for a in garments],
            "model_asset_id": model["id"],
        })
        project_id = project["id"]
        step["project_id"] = project_id
        evidence.data["project_id"] = project_id
    state = advance_to_script(api, evidence, project_id, api.state(project_id))
    return project_id, state


def resume(api, evidence, project_id):
    verify_health(api, evidence)
    credentials = environment_credentials(required=True)
    with evidence.step("resume_login_and_existing_project") as step:
        login = api.request("POST", "/api/auth/login", json=credentials)
        api.client.headers["Authorization"] = f"Bearer {login['token']}"
        project = api.request("GET", f"/api/projects/{project_id}")
        state = api.state(project_id)
        evidence.data.update(username=login["user"]["username"], project_id=project["id"])
        step["stage"] = state["stage"]
        step["image_count"] = len(state["images"])
        step["active_job_ids"] = [job["id"] for job in state["active_jobs"]]
    return advance_to_script(api, evidence, project_id, state)


def complete(api: API, evidence: Evidence, project_id, state, timeout, *, resuming=False):
    script = state.get("script") or {}
    needs_revision = state["stage"] == "script" and script.get("status") != "confirmed"
    if resuming and any(word in json.dumps(script, ensure_ascii=False)
                        for word in ("通勤", "办公室", "办公", "职场")):
        needs_revision = False
    if needs_revision:
        with evidence.step("free_text_revises_script") as step:
            before = state["script"]
            events = api.send(project_id, text="换成通勤风")
            assert cards(events, "script")
            state = api.state(project_id)
            revised = state["script"]
            assert script_hash(before) != script_hash(revised), "Script must actually change"
            narrative = json.dumps(revised, ensure_ascii=False)
            assert any(word in narrative for word in ("通勤", "办公室", "办公", "职场"))
            assert revised["status"] == "draft" and not state["active_jobs"]
            assert not state["images"], "Paid generation must wait for script confirmation"
            step["script"] = revised
    jobs = []
    if state["stage"] == "script":
        with evidence.step("confirm_script") as step:
            events = api.send(project_id, action={"type": "confirm_script"})
            jobs = [e["data"] for e in events if e["event"] == "job"]
            assert len(jobs) >= 4
            for job in jobs:
                fetched = api.request("GET", f"/api/jobs/{job['id']}")
                assert fetched["project_id"] == project_id and fetched["kind"] == "image"
            step["job_ids"] = [job["id"] for job in jobs]
    with evidence.step("wait_or_reuse_generated_images") as step:
        state = api.wait(project_id, lambda s: (
            len([i for i in s["images"] if i["version"] == 1]) >= 4
            and all(i["status"] == "succeeded" for i in s["images"] if i["version"] == 1)
        ), timeout=timeout)
        originals = [i for i in state["images"] if i["version"] == 1]
        step["jobs"] = [api.request("GET", f"/api/jobs/{j['id']}") for j in jobs]
        step["images"] = originals
        step["reused"] = not bool(jobs)
    with evidence.step("edit_or_reuse_image_version_two") as step:
        original = originals[0]
        instruction = "这张衬衫塞进裤腰，保持人物和通勤场景不变"
        existing = [i for i in state["images"]
                    if i.get("parent_id") == original["id"]
                    and i.get("instruction") == instruction]
        if not existing:
            assert state["stage"] == "images", "Existing project has no edit before note/video"
            events = api.send(project_id, action={
                "type": "edit_image", "image_id": original["id"],
                "instruction": instruction,
            })
            assert any(e["event"] == "job" for e in events)
        state = api.wait(project_id, lambda s: any(
            i.get("instruction") == instruction and i.get("parent_id") == original["id"]
            and i["status"] == "succeeded" for i in s["images"]
        ), timeout=timeout)
        edited = next(i for i in state["images"]
                      if i.get("instruction") == instruction
                      and i.get("parent_id") == original["id"])
        assert edited["parent_id"] == original["id"]
        assert edited["shot_id"] == original["shot_id"]
        assert isinstance(edited["edit_check"]["passed"], bool)
        assert edited["edit_check"]["reason"]
        step["image"] = edited
        step["reused"] = bool(existing)
    with evidence.step("local_edit_or_reuse") as step:
        target = originals[1]
        instruction = "只把圈选处的袖口放下来，人物和其他区域保持不变"
        existing = next((i for i in state["images"]
                         if i.get("parent_id") == target["id"]
                         and i.get("instruction") == instruction), None)
        if not existing:
            assert state["stage"] in {"images", "note"}
            events = api.send(project_id, action={
                "type": "edit_image", "image_id": target["id"], "instruction": instruction,
                "mask_strokes": {"brush": 0.10, "strokes": [
                    [{"x": 0.25, "y": 0.32}, {"x": 0.29, "y": 0.38}],
                ]},
            })
            assert any(e["event"] == "job" for e in events)
        state = api.wait(project_id, lambda s: any(
            i.get("parent_id") == target["id"] and i.get("instruction") == instruction
            and i["status"] == "succeeded" for i in s["images"]
        ), timeout=timeout)
        local = next(i for i in state["images"]
                     if i.get("parent_id") == target["id"] and i.get("instruction") == instruction)
        assert local["region"]["w"] > 0 and local["region"]["h"] > 0
        assert isinstance(local["edit_check"]["passed"], bool) and local["edit_check"]["reason"]
        step.update(image=local, reused=bool(existing))
    with evidence.step("referenced_image_edit_or_reuse") as step:
        target = originals[2]
        instruction = "这张袖口卷起来了，放下来"
        history = api.request("GET", f"/api/projects/{project_id}/messages")
        previous = next((m for m in history
                         if m["role"] == "user" and m["text"] == instruction
                         and m.get("refs") == [target["id"]]), None)
        job_ids = []
        if previous:
            for run in reversed(evidence.data.get("previous_runs", [])):
                recorded = next((s for s in run.get("steps", [])
                                 if s["name"] == "referenced_image_edit_or_reuse"
                                 and s.get("refs") == [target["id"]]), None)
                if recorded:
                    job_ids = recorded.get("job_ids") or (
                        [recorded["image"]["id"]] if recorded.get("image") else []
                    )
                    break
            assert job_ids, "Existing referenced request needs its original job evidence to resume"
        step["refs"] = [target["id"]]
        if not previous:
            assert state["stage"] in {"images", "note"}
            events = api.send(project_id, text=instruction, refs=[target["id"]])
            job_ids = [e["data"]["id"] for e in events if e["event"] == "job"]
            assert len(job_ids) == 1
            step["job_ids"] = job_ids
            evidence.write()
            history = api.request("GET", f"/api/projects/{project_id}/messages")
            assert any(m["text"] == instruction and m.get("refs") == [target["id"]]
                       for m in history if m["role"] == "user")
        state = api.wait(project_id, lambda s: (
            not s["active_jobs"] and any(i.get("parent_id") == target["id"]
                                        and i["id"] in job_ids
                                        and not (i.get("instruction") or "").startswith("自动还原")
                                        and i["status"] == "succeeded" for i in s["images"])
        ), timeout=timeout)
        referenced = [i for i in state["images"] if i.get("parent_id") == target["id"]
                      and i["id"] in job_ids
                      and not (i.get("instruction") or "").startswith("自动还原")]
        assert referenced and referenced[-1]["shot_id"] == target["shot_id"]
        assert isinstance(referenced[-1]["edit_check"]["passed"], bool)
        step.update(refs=[target["id"]], image=referenced[-1], reused=bool(previous))
    with evidence.step("approve_or_reuse_note") as step:
        image_ids = [edited["id"], *[i["id"] for i in originals[1:]]]
        reused_note = bool(state.get("note"))
        if not reused_note:
            events = api.send(project_id, action={
                "type": "approve_images", "image_ids": image_ids,
            })
            assert cards(events, "note")
            state = api.state(project_id)
        note = state["note"]
        assert len(note["title"]) <= 20
        assert 5 <= len(note["tags"]) <= 8
        assert note["image_ids"] == image_ids
        assert "\n" in note["body"], "Note should contain paragraphs"
        if not state.get("video"):
            assert state["pending_action"]["type"] == "confirm_video"
        step["note"] = note
        step["reused"] = reused_note
    with evidence.step("confirm_or_reuse_video_and_download") as step:
        reused_video = bool(state.get("video"))
        if not reused_video:
            events = api.send(project_id, action={
                "type": "confirm_video", "image_id": edited["id"],
            })
            jobs = [e["data"] for e in events if e["event"] == "job"]
            assert len(jobs) == 1 and jobs[0]["kind"] == "video"
        state = api.wait(project_id, lambda s: (
            (s.get("video") or {}).get("status") == "succeeded" and not s["active_jobs"]
        ), timeout=timeout)
        video = state["video"]
        response = api.client.get(video["url"])
        assert response.status_code == 200 and response.content
        assert response.headers.get("content-type", "").startswith("video/")
        step["bytes"] = len(response.content)
        step["job"] = api.request("GET", f"/api/jobs/{video['job_id']}")
        step["reused"] = reused_video
        assert state["stage"] == "done"
    with evidence.step("persisted_history") as step:
        history = api.request("GET", f"/api/projects/{project_id}/messages")
        kinds = {card["type"] for msg in history for card in msg["cards"]}
        assert {"garments", "directions", "script", "note"} <= kinds
        assert all(message["role"] in {"user", "assistant"} for message in history)
        assert project_id in {p["id"] for p in api.request("GET", "/api/projects")}
        step["message_count"] = len(history)
        step["card_types"] = sorted(kinds)
    return state


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--mode", choices=("mock", "real"), default="mock")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--resume", metavar="PROJECT_ID", help="Reuse existing project and paid jobs",
    )
    parser.add_argument("--timeout", type=int, default=900, help="Seconds for each worker phase")
    return parser.parse_args()


def main():
    args = arguments()
    path = args.output or ROOT / "artifacts" / f"e2e-{args.mode}-{int(time.time())}.json"
    evidence = Evidence(path, args.mode, args.base_url, preserve_previous=bool(args.resume))
    api = API(args.base_url)
    started = time.monotonic()
    try:
        if args.resume:
            project_id = args.resume
            evidence.data["project_id"] = project_id
            evidence.data["resumed"] = True
            state = resume(api, evidence, project_id)
        else:
            project_id, state = prepare(api, evidence)
        complete(api, evidence, project_id, state, args.timeout, resuming=bool(args.resume))
        evidence.finish(total_duration_s=round(time.monotonic() - started, 3))
        print(f"PASS: {path}")
        return 0
    except Exception as exc:
        evidence.data.update(
            status="failed", error_type=type(exc).__name__,
            finished_at=datetime.now(UTC).isoformat(),
        )
        evidence.write()
        print(f"FAIL ({type(exc).__name__}); sanitized evidence: {path}", file=sys.stderr)
        return 1
    finally:
        api.close()


if __name__ == "__main__":
    raise SystemExit(main())
