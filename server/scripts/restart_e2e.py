#!/usr/bin/env python3
"""Prove checkpoint/history persistence across this project's API restart."""

from __future__ import annotations

import subprocess
import sys
import time

from e2e import API, ROOT, Evidence, arguments, cards, prepare, safe, script_hash


def main():
    args = arguments()
    path = args.output or ROOT / "artifacts" / f"restart-{args.mode}-{int(time.time())}.json"
    evidence = Evidence(path, args.mode, args.base_url)
    api = API(args.base_url)
    try:
        project_id, before = prepare(api, evidence)
        history = api.request("GET", f"/api/projects/{project_id}/messages")
        with evidence.step("restart_only_this_projects_api") as step:
            # Explicit compose working directory scopes the restart to this project.
            result = subprocess.run(
                ["docker", "compose", "restart", "api"], cwd=ROOT,
                capture_output=True, text=True, timeout=90, check=True,
            )
            step["exit_code"] = result.returncode
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                try:
                    if api.request("GET", "/api/health")["ok"]:
                        break
                except Exception:
                    time.sleep(1)
            else:
                raise TimeoutError("API did not recover after restart")
        with evidence.step("verify_checkpoint_and_history") as step:
            after = api.state(project_id)
            assert after["stage"] == before["stage"] == "script"
            assert after["pending_action"]["type"] == "confirm_script"
            assert after["chosen_direction_id"] == before["chosen_direction_id"]
            assert script_hash(after["script"]) == script_hash(before["script"])
            assert safe(api.request("GET", f"/api/projects/{project_id}/messages")) == safe(history)
            assert after["directions"] == before["directions"]
            step["stage"] = after["stage"]
            step["message_count"] = len(history)
            step["pending_action"] = after["pending_action"]
        with evidence.step("resume_free_text_from_script_stage") as step:
            events = api.send(project_id, text="换成通勤风")
            assert cards(events, "script") and not cards(events, "directions")
            resumed = api.state(project_id)
            assert resumed["stage"] == "script"
            assert resumed["chosen_direction_id"] == before["chosen_direction_id"]
            assert script_hash(resumed["script"]) != script_hash(before["script"])
            assert not resumed["active_jobs"] and not resumed["images"]
            step["script"] = resumed["script"]
        evidence.finish(project_id=project_id)
        print(f"PASS: {path}")
        return 0
    except Exception as exc:
        evidence.data.update(status="failed", error_type=type(exc).__name__)
        evidence.write()
        print(f"FAIL ({type(exc).__name__}); sanitized evidence: {path}", file=sys.stderr)
        return 1
    finally:
        api.close()


if __name__ == "__main__":
    raise SystemExit(main())
