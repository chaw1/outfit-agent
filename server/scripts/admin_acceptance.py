#!/usr/bin/env python3
"""Verify admin/App/Worker integration on this worktree's local Mock stack.

ADMIN_TOKEN must be a temporary test value in the process environment. Evidence
never stores credentials. Settings are restored even when a check fails.
"""

import copy
import os
import time
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import httpx
from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.config import settings
from app.db import SessionLocal
from app.models import Asset, Job, Project, utcnow
from scripts.e2e import API, Evidence, advance_to_script

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18080"


def run():
    database = make_url(settings.database_url)
    assert database.host in {"localhost", "127.0.0.1"} and database.port == 18432
    token = os.environ.get("ADMIN_TOKEN")
    assert token, "Supply an ephemeral ADMIN_TOKEN for the local Mock verification"
    evidence = Evidence(ROOT / "artifacts/admin/acceptance.json", "mock", BASE)
    api = API(BASE)
    admin = httpx.Client(base_url=BASE, trust_env=False, timeout=30)
    original = None

    def request(method, path, **kwargs):
        response = admin.request(method, "/api/admin" + path, **kwargs)
        response.raise_for_status()
        return response.json()

    try:
        assert api.request("GET", "/api/health")["providers"]["mock"] is True
        with evidence.step("admin_login_and_app_isolation"):
            assert admin.post("/api/admin/login", json={"token": "wrong"}).status_code == 401
            assert admin.get("/api/admin/overview").status_code == 401
            login = request("POST", "/login", json={"token": token})
            admin.headers["Authorization"] = "Bearer " + login["token"]
            credentials, user = api.register("admin_verify")
            assert api.client.get("/api/admin/overview").status_code in {401, 403}
            assert admin.get("/api/me").status_code == 401
            assert admin.get("/admin").status_code == 200
        original = request("GET", "/settings")
        original = {key: original[key] for key in ("models", "tiers", "global_daily_budget_cny")}
        garment = api.upload("shirt.jpg", "garment")
        project = api.request("POST", "/api/projects", json={
            "title": "管理端验收", "brand": "本地验证", "brief": "夏日通勤穿搭",
            "garment_asset_ids": [garment["id"]],
        })
        project_id = project["id"]
        evidence.data.update(project_id=project_id, user_id=user["id"])
        advance_to_script(api, evidence, project_id, api.state(project_id))
        api.wait(project_id, lambda state: not state["active_jobs"], timeout=30)
        with evidence.step("daily_budget_blocks_images_but_not_chat") as step:
            changed = copy.deepcopy(original)
            changed["tiers"]["free"]["daily_budget_cny"] = 0
            request("PUT", "/settings", json=changed)
            before = api.state(project_id)
            response = api.client.post(f"/api/projects/{project_id}/messages", json={
                "action": {"type": "confirm_script"},
            })
            assert response.status_code == 200 and "event: error" in response.text
            assert "预算" in response.text
            after = api.state(project_id)
            assert not after["images"] and not after["active_jobs"]
            assert before["script"]["status"] == after["script"]["status"] == "draft"
            api.send(project_id, text="拍摄时有什么建议？")
            step["rejected"] = "confirm_script; no paid jobs; chat completed"
        with evidence.step("tier_and_model_take_effect_without_restart") as step:
            request("PATCH", f"/users/{user['id']}", json={"tier": "pro"})
            available = request("GET", "/settings")["candidates"]["image"]
            alternate = next(model for model in available if model != original["models"]["image"])
            changed["models"]["image"] = alternate
            # Both tiers can use the selected model for this check.
            for tier in changed["tiers"].values():
                tier["models"] = list(set(tier["models"]) | {alternate})
            request("PUT", "/settings", json=changed)
            assert api.request("GET", "/api/health")["providers"]["image"] == alternate
            events = api.send(project_id, action={"type": "confirm_script"})
            job_ids = [event["data"]["id"] for event in events if event["event"] == "job"]
            assert job_ids
            api.wait(project_id, lambda state: not state["active_jobs"], timeout=40)
            with SessionLocal() as session:
                jobs = session.scalars(select(Job).where(Job.id.in_(job_ids))).all()
                models = [session.get(Asset, job.result_asset_id).model for job in jobs]
            assert models and set(models) == {alternate}
            step.update(model=alternate, job_ids=job_ids, asset_models=models)
        with evidence.step("disabled_user_and_reenable"):
            request("PATCH", f"/users/{user['id']}", json={"disabled": True})
            assert api.client.post("/api/auth/login", json=credentials).status_code == 403
            for method, path, body in (
                ("POST", "/api/projects", {"title": "禁用", "brand": "品牌", "brief": "测试",
                                          "garment_asset_ids": [garment["id"]]}),
                ("POST", f"/api/projects/{project_id}/messages", {"text": "你好"}),
                ("DELETE", f"/api/projects/{project_id}", None),
            ):
                assert api.client.request(method, path, json=body).status_code == 403
            with (ROOT / "fixtures/shirt.jpg").open("rb") as file:
                assert api.client.post("/api/assets", data={"kind": "garment"},
                                       files={"file": ("shirt.jpg", file, "image/jpeg")}
                                       ).status_code == 403
            request("PATCH", f"/users/{user['id']}", json={"disabled": False})
            logged_in = api.request("POST", "/api/auth/login", json=credentials)
            assert logged_in["user"]["id"] == user["id"]
            api.send(project_id, text="你好，继续聊聊")
        request("PUT", "/settings", json=original)
        with evidence.step("queue_retry_and_cancel_really_apply") as step:
            with SessionLocal() as session:
                queue_project = Project(user_id=user["id"], title="队列验收", brand="测试",
                                        brief="管理端队列")
                session.add(queue_project)
                session.flush()
                queued = Job(project_id=queue_project.id, user_id=user["id"], kind="image",
                             available_at=utcnow() + timedelta(hours=1), dedupe_key=str(uuid4()),
                             payload={"purpose": "preview", "prompt": "通勤", "direction_id": "q"})
                failed = Job(project_id=queue_project.id, user_id=user["id"], kind="image",
                             status="failed", attempts=3, error="本地验收失败样本",
                             dedupe_key=str(uuid4()),
                             payload={"purpose": "preview", "prompt": "通勤", "direction_id": "f"})
                session.add_all([queued, failed])
                session.commit()
                cancelled_id, failed_id = queued.id, failed.id
            request("POST", f"/jobs/{cancelled_id}/cancel")
            request("POST", f"/jobs/{failed_id}/retry")
            deadline = time.monotonic() + 30
            while True:
                result = api.request("GET", f"/api/jobs/{failed_id}")
                if result["status"] == "succeeded":
                    break
                assert result["status"] != "failed", result["error"]
                assert time.monotonic() < deadline
                time.sleep(.2)
            with SessionLocal() as session:
                cancelled = session.get(Job, cancelled_id)
                assert cancelled.status == "failed" and cancelled.attempts == 0
                assert cancelled.result.get("cancelled") is True
                assert session.get(Job, failed_id).attempts == 1
            step.update(
                cancelled_job=cancelled_id, retried_job=failed_id, retried_status="succeeded"
            )
        with evidence.step("overview_usage_filters_and_csv") as step:
            overview = request("GET", "/overview")
            for group in ("model", "user", "day"):
                usage = request("GET", "/usage", params={"group": group, "user_id": user["id"]})
                response = admin.get("/api/admin/usage.csv", params={
                    "group": group, "user_id": user["id"],
                })
                response.raise_for_status()
                assert "text/csv" in response.headers["content-type"]
                (ROOT / f"artifacts/admin/usage-{group}.csv").write_bytes(response.content)
                step[group] = usage
            step["overview"] = overview
        evidence.finish(real_cost_cny=0)
        print("Admin integration passed; artifacts/admin/acceptance.json")
    finally:
        if original is not None:
            request("PUT", "/settings", json=original)
        admin.close()
        api.close()


if __name__ == "__main__":
    run()
