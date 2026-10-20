#!/usr/bin/env python3
"""Run the complete zero-cost admin review with an ephemeral process-only token.

Only this worktree's local Compose project is modified. On exit the local API
and worker are recreated in Mock mode with the admin switch disabled.
"""

import argparse
import json
import os
import secrets
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts/admin"
COMPOSE = ["docker", "compose", "-f", "compose.yaml", "-p", "outfit-agent-server"]


def run(*, browser_only=False):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.pop("COMPOSE_FILE", None)
    env.pop("COMPOSE_PROJECT_NAME", None)
    env.update({
        "ADMIN_TOKEN": secrets.token_urlsafe(32), "MOCK_PROVIDERS": "1",
        "DASHSCOPE_API_KEY": "", "DEEPSEEK_API_KEY": "", "REQUIRE_INTEGRATION": "1",
        "DATABASE_URL": "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
        "TEST_DATABASE_URL": "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
        "API_BASE_URL": "http://127.0.0.1:18080", "POSTGRES_PASSWORD": "outfit",
    })
    steps = []
    report_name = "review-browser.json" if browser_only else "review.json"

    def record(name, status, seconds):
        steps.append({"name": name, "status": status, "seconds": round(seconds, 3)})
        (ARTIFACTS / report_name).write_text(json.dumps({
            "started_at": started_at, "real_cost_cny": 0, "steps": steps,
        }, ensure_ascii=False, indent=2) + "\n")

    def command(name, args, timeout=600, *, process_env=None):
        print("Running " + name, flush=True)
        started = time.monotonic()
        with (ARTIFACTS / (name + ".log")).open("w") as output:
            result = subprocess.run(args, cwd=ROOT, env=process_env or env,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        record(name, "passed" if result.returncode == 0 else "failed", time.monotonic() - started)
        if result.returncode:
            print((ARTIFACTS / (name + ".log")).read_text()[-5000:], flush=True)
            raise RuntimeError(name + " failed; inspect artifacts/admin/" + name + ".log")

    def wait_for_health():
        deadline = time.monotonic() + 90
        while True:
            try:
                response = httpx.get(
                    "http://127.0.0.1:18080/api/health", trust_env=False, timeout=2
                )
                response.raise_for_status()
                assert response.json()["providers"]["mock"] is True
                return
            except (httpx.HTTPError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.5)

    started_at = datetime.now(UTC).isoformat()
    try:
        command("build", [*COMPOSE, "up", "-d", "--build", "api", "worker"])
        wait_for_health()
        if not browser_only:
            command("pytest", ["uv", "run", "pytest", "-q"])
            command("ruff", ["uv", "run", "ruff", "check", "."])
            command("acceptance", ["uv", "run", "python", "-m", "scripts.admin_acceptance"])
            command("e2e", ["uv", "run", "python", "scripts/e2e.py", "--mode", "mock",
                            "--output", "artifacts/admin/e2e.json"])
            command("experiments", ["uv", "run", "python", "scripts/experiments.py",
                                    "--output", "artifacts/admin/experiments.json"])
        command("browser", ["uv", "run", "--with", "playwright", "python",
                            "scripts/admin_browser.py"])
        response = httpx.get("http://127.0.0.1:18080/openapi.json", trust_env=False, timeout=10)
        response.raise_for_status()
        assert response.json() == json.loads((ROOT / "openapi.json").read_text())
        record("openapi_live_matches", "passed", 0)
    finally:
        safe_env = {**env, "ADMIN_TOKEN": ""}
        command(
            "restore_disabled_mock", [*COMPOSE, "up", "-d", "--force-recreate", "api", "worker"],
            process_env=safe_env,
        )
        wait_for_health()
        for method, path in (("GET", "/admin"), ("GET", "/api/admin/overview"),
                             ("POST", "/api/admin/login")):
            response = httpx.request(method, "http://127.0.0.1:18080" + path,
                                     content="invalid-json", trust_env=False)
            assert response.status_code == 404
        record("closed_admin_404", "passed", 0)
    print(f"Complete: artifacts/admin/{report_name}; local stack Mock, admin disabled.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-only", action="store_true",
                        help="Only recheck screenshots after a browser-script-only fix")
    run(browser_only=parser.parse_args().browser_only)
