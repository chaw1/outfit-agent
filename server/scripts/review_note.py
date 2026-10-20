#!/usr/bin/env python3
"""Verify explicit copy revisions preserve a completed project's media jobs.

Uses E2E_USERNAME/E2E_PASSWORD from the process environment. This invokes one
text-model call in real mode. No credentials or signed URLs enter the evidence.
"""

import argparse
import json
import os
import time
from pathlib import Path

from e2e import API, safe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--mode", choices=["real"], required=True)
    parser.add_argument("--output", type=Path, default=Path("artifacts/note-quality-review.json"))
    args = parser.parse_args()
    api = API(args.base_url)
    started = time.monotonic()
    try:
        health = api.request("GET", "/api/health")
        assert health["providers"]["mock"] is False
        login = api.request(
            "POST",
            "/api/auth/login",
            json={
                "username": os.environ["E2E_USERNAME"],
                "password": os.environ["E2E_PASSWORD"],
            },
        )
        api.client.headers["Authorization"] = f"Bearer {login['token']}"
        before = api.state(args.project_id)
        assert before["stage"] == "done" and before["video"]["status"] == "succeeded"
        events = api.send(
            args.project_id,
            text=(
                "改一下笔记：第一张封面的衬衫已经塞进裤腰，请据此改正文，"
                "不能再写封面衬衫下摆放在裤腰外。不要编造我穿了一天、坐一天、"
                "不勒不闷等没有提供的试穿体验。只写看得到的颜色、版型、搭配处理，"
                "保持自然的小红书口吻，标题不超过20字，分段带表情和5到8个标签。"
            ),
        )
        after = api.state(args.project_id)
        assert any(e["event"] == "card" and e["data"]["type"] == "note" for e in events)
        assert not any(e["event"] == "job" for e in events)
        assert after["stage"] == "done" and after["pending_action"] is None
        assert after["video"]["job_id"] == before["video"]["job_id"]
        assert [i["id"] for i in after["images"]] == [i["id"] for i in before["images"]]
        note = after["note"]
        assert note["image_ids"] == before["note"]["image_ids"]
        assert note != before["note"]
        assert len(note["title"]) <= 20 and 5 <= len(note["tags"]) <= 8
        assert "\n" in note["body"] and "裤腰" in note["body"]
        assert any(word in note["body"] for word in ["塞", "扎进"])
        assert not any(word in note["body"] for word in ["坐一天", "一整天", "不勒", "不闷"])
        evidence = {
            "status": "passed",
            "project_id": args.project_id,
            "duration_s": round(time.monotonic() - started, 3),
            "before": before["note"],
            "after": note,
            "video_job_id": after["video"]["job_id"],
            "new_media_jobs": 0,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(safe(evidence), ensure_ascii=False, indent=2) + "\n")
        print(f"PASS: {args.output}")
    finally:
        api.close()


if __name__ == "__main__":
    main()
