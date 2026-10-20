#!/usr/bin/env python3
"""Mock-only public HTTP/readonly PostgreSQL acceptance for operations changes.

The only writes are API requests for two newly registered verification accounts
and their own newly created projects. No container operations or paid providers.
Evidence omits passwords, bearer credentials and signed URL query strings.
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.e2e import API, Evidence, cards  # noqa: E402

PREFERENCE = "喜欢松弛感，不穿高跟鞋"
LOCAL_HOSTS = {"127.0.0.1", "localhost"}


def local_api_url(value: str, *, media: bool = False) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in LOCAL_HOSTS or parsed.port != 18080
            or parsed.username or parsed.password or parsed.fragment):
        raise ValueError("Acceptance permits only this project's local Mock API on port 18080")
    if media:
        if not parsed.path.startswith("/media/"):
            raise ValueError("Expected this project's signed media URL")
    elif parsed.path not in {"", "/"} or parsed.query:
        raise ValueError("API base URL must not include a path or query")
    return value.rstrip("/")


def local_database_url(value: str) -> str:
    parsed = make_url(value)
    if (parsed.get_backend_name() != "postgresql" or parsed.host not in LOCAL_HOSTS
            or parsed.port != 18432 or parsed.database != "outfit" or parsed.query):
        raise ValueError("Acceptance permits only local PostgreSQL port 18432 database outfit")
    return parsed.set(drivername="postgresql").render_as_string(hide_password=False)


def project_snapshot(connection, project_id: str, user_id: str) -> dict:
    """Every query is bounded by the project this run just created and its owner."""
    project = connection.execute(
        "SELECT model_asset_id,deleted_at FROM projects WHERE id=%s AND user_id=%s",
        (project_id, user_id),
    ).fetchone()
    assert project is not None, "Verification project ownership does not match the local database"
    snapshot = {"model_asset_id": project[0], "deleted": project[1] is not None}
    for table in ("messages", "jobs"):
        snapshot[table] = connection.execute(sql.SQL(
            "SELECT count(*) FROM {} WHERE project_id=%s AND EXISTS "
            "(SELECT 1 FROM projects WHERE id=%s AND user_id=%s)"
        ).format(sql.Identifier(table)), (project_id, project_id, user_id)).fetchone()[0]
    for table in ("checkpoints", "checkpoint_writes", "checkpoint_blobs"):
        snapshot[table] = connection.execute(sql.SQL(
            "SELECT count(*) FROM {} WHERE thread_id=%s AND EXISTS "
            "(SELECT 1 FROM projects WHERE id=%s AND user_id=%s)"
        ).format(sql.Identifier(table)), (project_id, project_id, user_id)).fetchone()[0]
    generated = connection.execute(
        "SELECT id FROM assets WHERE project_id=%s AND user_id=%s AND source='generated'",
        (project_id, user_id),
    ).fetchall()
    snapshot["generated_assets"] = len(generated)
    snapshot["generated_asset_ids"] = [row[0] for row in generated]
    snapshot["job_ids"] = [row[0] for row in connection.execute(
        "SELECT id FROM jobs WHERE project_id=%s AND user_id=%s", (project_id, user_id)
    ).fetchall()]
    return snapshot


def run(base_url: str, database_url: str, output: Path):
    base_url = local_api_url(base_url)
    database_url = local_database_url(database_url)
    output = output.resolve()
    if not output.is_relative_to(ROOT):
        raise ValueError("Acceptance evidence must remain in this server worktree")
    evidence = Evidence(output, "mock", base_url, preserve_previous=True)
    api, other_api = API(base_url), API(base_url)
    owned_projects = []
    deleted_projects = set()
    user_id = None
    connection = None
    try:
        with evidence.step("local_mock_health_and_request_ids") as step:
            response = api.client.get("/api/health")
            response.raise_for_status()
            assert response.json()["ok"] is True
            assert response.json()["providers"]["mock"] is True, "Mock service is required"
            automatic_id = response.headers.get("X-Request-Id")
            assert automatic_id and len(automatic_id) <= 128
            supplied_id = "ops-acceptance-" + uuid.uuid4().hex
            echoed = api.client.get("/api/health", headers={"X-Request-Id": supplied_id})
            assert echoed.status_code == 200 and echoed.headers["X-Request-Id"] == supplied_id
            step.update(automatic_request_id=automatic_id, supplied_request_id=supplied_id,
                        supplied_id_echoed=True, mock=True)

        # Read-only mode is enforced by PostgreSQL itself, before the first query.
        connection = psycopg.connect(database_url, autocommit=True,
                                     options="-c default_transaction_read_only=on")
        assert connection.execute("SHOW transaction_read_only").fetchone() == ("on",)
        with evidence.step("register_isolated_accounts_and_me") as step:
            _, user = api.register("ops")
            _, other = other_api.register("ops_other")
            user_id = user["id"]
            me = api.request("GET", "/api/me")
            assert me["id"] == user_id
            assert {"tier", "daily_budget_cny", "today_cost_cny", "profile"} <= me.keys()
            assert me["profile"]["model_asset_ids"] == []
            assert me["daily_budget_cny"] >= 0 and me["today_cost_cny"] == 0
            step.update(user_id=user_id, other_user_id=other["id"], tier=me["tier"],
                        daily_budget_cny=me["daily_budget_cny"], me_fields_verified=True)

        with evidence.step("upload_owned_garment_and_two_models") as step:
            garment = api.upload("shirt.jpg", "garment")
            model_a = api.upload("model.jpg", "model")
            model_b = api.upload("model.jpg", "model")
            other_model = other_api.upload("model.jpg", "model")
            uploaded = [garment, model_a, model_b]
            for asset in uploaded:
                local_api_url(asset["url"], media=True)
                response = api.client.get(asset["url"])
                assert response.status_code == 200 and response.content
            step.update(garment_id=garment["id"], model_ids=[model_a["id"], model_b["id"]],
                        upload_signatures_readable=True)

        with evidence.step("patch_profile_partial_merge_and_photo_ownership") as step:
            patched = api.request("PATCH", "/api/me", json={"nickname": "运维验收博主", "profile": {
                "model_asset_ids": [model_b["id"], model_a["id"]], "height_cm": 168,
                "body_notes": "肩宽", "style_notes": PREFERENCE,
            }})
            assert patched["nickname"] == "运维验收博主"
            assert patched["profile"]["model_asset_ids"] == [model_b["id"], model_a["id"]]
            patched = api.request("PATCH", "/api/me", json={"profile": {"body_notes": "自然比例"}})
            assert patched["profile"]["height_cm"] == 168
            assert patched["profile"]["style_notes"] == PREFERENCE
            denied = api.client.patch("/api/me", json={"profile": {
                "model_asset_ids": [other_model["id"]],
            }})
            assert denied.status_code in {403, 422}
            assert "本人上传" in denied.json()["error"]["message"]
            assert api.request("GET", "/api/me")["profile"]["model_asset_ids"] == [
                model_b["id"], model_a["id"],
            ]
            step.update(partial_merge=True, foreign_photo_status=denied.status_code,
                        foreign_photo_message=denied.json()["error"]["message"],
                        rejection_preserves_profile=True)

        def create_project(*, explicit=None):
            body = {"title": "运维验收-" + uuid.uuid4().hex[:8], "brand": "本地验收品牌",
                    "brief": "夏季白衬衫日常穿搭", "garment_asset_ids": [garment["id"]]}
            if explicit is not None:
                body["model_asset_id"] = explicit
            result = api.request("POST", "/api/projects", json=body)
            owned_projects.append(result["id"])
            return result["id"]

        with evidence.step("project_defaults_follow_photo_order_and_explicit_override") as step:
            primary_id = create_project()
            first = project_snapshot(connection, primary_id, user_id)
            assert first["model_asset_id"] == model_b["id"]
            api.request("PATCH", "/api/me", json={"profile": {
                "model_asset_ids": [model_a["id"], model_b["id"]],
            }})
            reordered_id = create_project()
            reordered = project_snapshot(connection, reordered_id, user_id)
            assert reordered["model_asset_id"] == model_a["id"]
            explicit_id = create_project(explicit=model_b["id"])
            explicit = project_snapshot(connection, explicit_id, user_id)
            assert explicit["model_asset_id"] == model_b["id"]
            step.update(primary_project_id=primary_id, project_ids=list(owned_projects),
                        default_first_photo=True, reordered_default=True, explicit_override=True)

        with evidence.step("saved_preferences_shape_mock_directions_and_script") as step:
            directions = cards(api.send(primary_id, text="帮我想两个日常方向"), "directions")
            assert len(directions) == 1
            assert all("松弛" in item["why"] and "平底" in item["why"]
                       for item in directions[0]["options"])
            state = api.wait(primary_id, lambda item: not item["active_jobs"], timeout=120)
            assert all(item["preview_status"] == "succeeded" for item in state["directions"])
            events = api.send(primary_id, action={"type": "choose_direction",
                                                 "direction_id": state["directions"][0]["id"]})
            scripts = cards(events, "script")
            assert len(scripts) == 1
            assert all("松弛" in shot["caption"] and "平底" in shot["pose"]
                       for shot in scripts[0]["shots"])
            step.update(preference=PREFERENCE, directions=directions[0]["options"],
                        script=scripts[0], preference_from_profile=True)

        with evidence.step("mock_generation_before_delete_is_not_vacuous") as step:
            api.send(primary_id, action={"type": "confirm_script"})
            state = api.wait(primary_id, lambda item: bool(item["images"])
                             and not item["active_jobs"]
                             and all(image["status"] == "succeeded" for image in item["images"]),
                             timeout=120)
            generated_urls = [item["preview_url"] for item in state["directions"]]
            generated_urls.extend(item["url"] for item in state["images"])
            assert generated_urls
            for url in generated_urls:
                local_api_url(url, media=True)
                assert api.client.get(url).status_code == 200
            before = project_snapshot(connection, primary_id, user_id)
            assert all(before[key] > 0 for key in (
                "messages", "jobs", "checkpoints", "checkpoint_writes",
                "checkpoint_blobs", "generated_assets",
            ))
            assert len(generated_urls) == before["generated_assets"]
            step.update(project_id=primary_id, before=before,
                        generated_media_readable=len(generated_urls),
                        model_cost_cny=state["cost_cny"])
            assert state["cost_cny"] == 0, "Acceptance must not spend money"

        with evidence.step("delete_cascades_but_uploaded_originals_remain") as step:
            deleted = api.client.delete(f"/api/projects/{primary_id}")
            assert deleted.status_code in {200, 204}
            deleted_projects.add(primary_id)
            unavailable = [f"/api/projects/{primary_id}", f"/api/projects/{primary_id}/messages",
                           f"/api/projects/{primary_id}/state"]
            unavailable.extend(f"/api/jobs/{job_id}" for job_id in before["job_ids"])
            for path in unavailable:
                assert api.client.get(path).status_code == 404
            for url in generated_urls:
                assert api.client.get(url).status_code == 404
            for asset in uploaded:
                response = api.client.get(asset["url"])
                assert response.status_code == 200 and response.content
            after = project_snapshot(connection, primary_id, user_id)
            assert after["deleted"] is True
            assert all(after[key] == 0 for key in (
                "messages", "jobs", "checkpoints", "checkpoint_writes",
                "checkpoint_blobs", "generated_assets",
            ))
            step.update(after=after, missing_api_paths=unavailable,
                        generated_media_404=len(generated_urls), upload_originals_readable=True,
                        retained_upload_ids=[asset["id"] for asset in uploaded])

        evidence.finish(model_calls="Mock only", cost_cny=0,
                        scope="New accounts and projects created by this run only")
    finally:
        cleanup = []
        for project_id in owned_projects:
            if project_id in deleted_projects:
                continue
            try:
                project_snapshot(connection, project_id, user_id)
                response = api.client.delete(f"/api/projects/{project_id}")
                assert response.status_code in {200, 204, 404}
                cleanup.append({"project_id": project_id, "status_code": response.status_code})
            except Exception as exc:
                cleanup.append({"project_id": project_id, "error_type": type(exc).__name__})
        evidence.data["cleanup_of_this_runs_other_projects"] = cleanup
        if any("error_type" in result for result in cleanup):
            evidence.data["status"] = "failed"
        evidence.write()
        if connection is not None:
            connection.close()
        api.close()
        other_api.close()
    if evidence.data["status"] != "passed":
        raise RuntimeError("Verification project cleanup failed; see sanitized evidence")
    print(f"Operations acceptance passed; sanitized evidence: {output.relative_to(ROOT)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "artifacts" / "ops" / "acceptance.json")
    args = parser.parse_args()
    database_url = os.environ.get(
        "TEST_DATABASE_URL", "postgresql://outfit:outfit@127.0.0.1:18432/outfit"
    )
    run(args.base_url, database_url, args.output)


if __name__ == "__main__":
    main()
