#!/usr/bin/env python3
"""Run the four zero-cost persistence/gate experiments against the local Mock API."""

import argparse
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

from e2e import API, ROOT, Evidence, cards, prepare, safe, script_hash


def run(base_url, output):
    parsed = urlsplit(base_url)
    if parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port != 18080:
        raise ValueError("Experiments only operate this worktree's local Mock stack")
    evidence = Evidence(output, "mock", base_url)
    api = API(base_url)
    results = []

    def record(name, started, detail):
        results.append({"experiment": name, "passed": True,
                        "seconds": round(time.monotonic() - started, 3), "detail": detail})
        evidence.data["experiments"] = results
        evidence.write()

    try:
        project_id, state = prepare(api, evidence)
        api.wait(project_id, lambda s: not s["active_jobs"], timeout=60)
        started = time.monotonic()
        before = api.state(project_id)
        history = safe(api.request("GET", f"/api/projects/{project_id}/messages"))
        subprocess.run(["docker", "compose", "restart", "api"], cwd=ROOT,
                       capture_output=True, check=True, timeout=60)
        deadline = time.monotonic() + 60
        while True:
            try:
                if api.request("GET", "/api/health")["ok"]:
                    break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)
        state = api.state(project_id)
        assert state["stage"] == "script" and state["script"] == before["script"]
        assert safe(api.request("GET", f"/api/projects/{project_id}/messages")) == history
        record("E1 重启续聊", started, f"保留 {len(history)} 条消息、脚本和确认点")

        started = time.monotonic()
        first = api.send(project_id, action={"type": "confirm_script"})
        ids = [event["data"]["id"] for event in first if event["event"] == "job"]
        second = api.send(project_id, action={"type": "confirm_script"})
        assert [event["data"]["id"] for event in second if event["event"] == "job"] == ids
        state = api.wait(project_id, lambda s: not s["active_jobs"], timeout=60)
        edit = {"type": "edit_image", "image_id": ids[0], "instruction": "背景亮一点"}
        one = api.send(project_id, action=edit)
        two = api.send(project_id, action=edit)
        assert [e["data"]["id"] for e in one if e["event"] == "job"] == [
            e["data"]["id"] for e in two if e["event"] == "job"]
        state = api.wait(project_id, lambda s: not s["active_jobs"], timeout=60)
        assert len(state["images"]) == len(ids) + 1
        record("E2 重复确认", started, f"{len(ids)} 张原图、1 次改图，无重复入队")

        started = time.monotonic()
        before_ids = [image["id"] for image in state["images"]]
        response = api.client.post(f"/api/projects/{project_id}/messages", json={
            "action": {"type": "confirm_video", "image_id": ids[0]}})
        assert "tool_not_allowed" in response.text and "当前阶段" in response.text
        assert [image["id"] for image in api.state(project_id)["images"]] == before_ids
        record("E3 越阶段拒绝", started, "视频请求被代码门禁拒绝，未创建任务")

        started = time.monotonic()
        old = api.state(project_id)
        old_version = old["script"]["version"]
        original_checkpoint = next(v["checkpoint_id"] for v in old["script_versions"]
                                   if v["version"] == old_version)
        events = api.send(project_id, text="换成通勤风")
        assert cards(events, "script")
        revised = api.state(project_id)
        assert revised["stage"] == "script"
        assert script_hash(revised["script"]) != script_hash(old["script"])
        assert len(revised["script_versions"]) >= 2
        api.send(project_id, action={"type": "restore_script",
                                     "checkpoint_id": original_checkpoint})
        restored = api.state(project_id)
        assert restored["script"]["version"] == old_version
        for key in ("shots", "cover", "title_ideas"):
            assert restored["script"][key] == old["script"][key]
        assert restored["script"]["status"] == "draft"
        assert restored["pending_action"]["type"] == "confirm_script"
        assert [image["id"] for image in restored["images"]] == before_ids
        confirmed = api.send(project_id, action={"type": "confirm_script"})
        assert [e["data"]["id"] for e in confirmed if e["event"] == "job"] == ids
        record("E4 脚本时间旅行", started,
               f"v{revised['script']['version']} → v{old_version}，旧图保留")
        evidence.finish(project_id=project_id)
        return results
    finally:
        api.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/experiments-fix1.json")
    args = parser.parse_args()
    results = run(args.base_url, args.output)
    print("| 实验 | 结果 | 秒 | 证据 |\n|---|---|---:|---|")
    for item in results:
        print(f"| {item['experiment']} | PASS | {item['seconds']} | {item['detail']} |")


if __name__ == "__main__":
    main()
