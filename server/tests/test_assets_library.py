"""Personal library ownership, reusable copies and transaction-safe cleanup."""

import io
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app import worker
from app.config import settings
from app.main import app
from app.models import AppSetting, Asset, Base, Job, Project, User, utcnow
from app.project_cleanup import CLEANUP_PREFIX, cleanup_project, drain_media_cleanup
from app.providers import ProviderError, ProviderHub
from app.security import get_session, hash_password, issue_token
from app.workflow import Workflow


@pytest.fixture
def library_api(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'library.sqlite'}")

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    image_bytes = output.getvalue()
    with factory() as session:
        owner = User(id="owner", username="library-owner", nickname="本人",
                     password_hash=hash_password("password-round12"))
        other = User(id="other", username="library-other", nickname="他人",
                     password_hash="unused")
        session.add_all([owner, other])
        session.flush()
        for user in (owner, other):
            project = Project(id=f"{user.id}-project", user_id=user.id, title="操场那组",
                              brand="品牌", brief="穿搭", garment_asset_ids=[])
            session.add(project)
            session.flush()
            for suffix, kind, status, purpose in (
                ("image", "image", "succeeded", "formal"),
                ("edit", "edit", "succeeded", "formal"),
                ("preview", "image", "succeeded", "preview"),
                ("failed", "image", "failed", "formal"),
            ):
                asset_id = f"{user.id}-{suffix}-asset"
                path = f"{asset_id}.png"
                (settings.media_dir / path).write_bytes(image_bytes)
                session.add(Asset(id=asset_id, user_id=user.id, project_id=project.id,
                                  kind="reference", source="generated", path=path,
                                  mime="image/png", width=32, height=48))
                session.flush()
                session.add(Job(id=f"{user.id}-{suffix}", user_id=user.id,
                                project_id=project.id, kind=kind, status=status,
                                result_asset_id=asset_id, dedupe_key=f"{user.id}-{suffix}",
                                payload={"image_id": f"{user.id}-{suffix}", "purpose": purpose}))
        for user in (owner, other):
            poster_id, video_id = f"{user.id}-image-asset", f"{user.id}-video-asset"
            (settings.media_dir / f"{video_id}.mp4").write_bytes(b"fake-mp4")
            session.add(Asset(id=video_id, user_id=user.id, project_id=f"{user.id}-project",
                              kind="reference", source="generated", path=f"{video_id}.mp4",
                              mime="video/mp4"))
            session.flush()
            session.add(Job(id=f"{user.id}-video", user_id=user.id,
                            project_id=f"{user.id}-project", kind="video", status="succeeded",
                            result_asset_id=video_id, dedupe_key=f"{user.id}-video",
                            payload={"image_asset_id": poster_id, "poster_asset_id": poster_id}))
        for kind in ("model", "garment"):
            path = f"upload-{kind}.png"
            (settings.media_dir / path).write_bytes(image_bytes)
            session.add(Asset(id=f"upload-{kind}", user_id=owner.id, kind=kind,
                              source="upload", path=path, mime="image/png", width=32, height=48))
        session.commit()

    def override_session():
        with factory() as session:
            yield session

    previous = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = override_session
    client = TestClient(app, raise_server_exceptions=False,
                        headers={"Authorization": "Bearer " + issue_token("owner")})
    try:
        yield SimpleNamespace(client=client, factory=factory, media=settings.media_dir)
    finally:
        client.close()
        if previous is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous
        engine.dispose()


def save_model(env, image_id="owner-image", **extra):
    return env.client.post("/api/me/models/from-image", json={"image_id": image_id, **extra})


def test_save_copies_image_and_is_idempotent_with_default_name(library_api):
    env = library_api
    response = save_model(env)
    assert response.status_code == 200, response.text
    result = response.json()
    asset = result["asset"]
    assert (asset["kind"], asset["source"], asset["parent_id"]) == (
        "model", "generated", "owner-image-asset",
    )
    assert asset["project_id"] == "owner-project" and asset["name"] == "操场那组"
    assert asset["in_profile"] is True
    assert result["user"]["profile"]["model_asset_ids"] == [asset["id"]]
    again = save_model(env, "owner-image-asset", name="重试不改名")
    assert again.status_code == 200 and again.json()["asset"]["id"] == asset["id"]
    assert again.json()["asset"]["name"] == "操场那组"
    with env.factory() as session:
        copy = session.get(Asset, asset["id"])
        assert copy.path != "owner-image-asset.png"
        assert (env.media / copy.path).read_bytes() == (
            env.media / "owner-image-asset.png"
        ).read_bytes()
        assert len(session.scalars(select(Asset).where(Asset.kind == "model")).all()) == 2


@pytest.mark.parametrize("image_id", [
    "other-image", "other-image-asset", "owner-preview", "owner-failed", "upload-model", "missing",
])
def test_save_requires_owned_successful_final_image(library_api, image_id):
    assert save_model(library_api, image_id).status_code == 404


def test_model_limit_and_repeat_at_capacity(library_api):
    env = library_api
    saved = save_model(env, name="操场那组的她").json()["asset"]
    with env.factory() as session:
        user = session.get(User, "owner")
        ids = [saved["id"]]
        for _ in range(19):
            asset = Asset(user_id=user.id, kind="model", source="upload", path="upload-model.png",
                          mime="image/png")
            session.add(asset)
            session.flush()
            ids.append(asset.id)
        user.profile = {"model_asset_ids": ids, "style_notes": "松弛感"}
        session.commit()
    assert save_model(env).status_code == 200
    response = save_model(env, "owner-edit")
    assert response.status_code == 422 and "20" in response.json()["error"]["message"]
    assert "模特" in response.json()["error"]["message"]
    assert env.client.get("/api/me").json()["profile"]["style_notes"] == "松弛感"


def test_saved_model_can_be_default(library_api):
    env = library_api
    asset_id = save_model(env).json()["asset"]["id"]
    response = env.client.patch("/api/me", json={"profile": {"model_asset_ids": [asset_id]}})
    assert response.status_code == 200
    created = env.client.post("/api/projects", json={
        "title": "再拍一组", "brand": "品牌", "brief": "穿搭",
        "garment_asset_ids": ["upload-garment"],
    })
    assert created.status_code == 200
    with env.factory() as session:
        assert session.get(Project, created.json()["id"]).model_asset_id == asset_id


def test_library_lists_all_kinds_with_metadata_and_stable_pagination(library_api):
    env = library_api
    saved = save_model(env, name="操场那组的她").json()["asset"]
    response = env.client.get("/api/me/assets", params={"kind": "model", "limit": 1})
    assert response.status_code == 200
    listing = response.json()
    assert listing["total"] == 2 and listing["items"][0]["id"] == saved["id"]
    assert listing["items"][0]["project_title"] == "操场那组"
    assert listing["items"][0]["name"] == "操场那组的她"
    assert listing["items"][0]["in_profile"] is True
    second = env.client.get("/api/me/assets", params={
        "kind": "model", "limit": 1, "offset": 1,
    }).json()
    assert second["total"] == 2 and second["items"][0]["id"] == "upload-model"
    assert second["items"][0]["in_profile"] is False
    assert second["items"][0]["project_id"] is None
    assert second["items"][0]["project_title"] is None and second["items"][0]["name"] is None
    assert env.client.get("/api/me/assets", params={
        "kind": "model", "offset": 2,
    }).json() == {"items": [], "total": 2}
    garments = env.client.get("/api/me/assets", params={"kind": "garment"}).json()
    assert garments["total"] == 1 and garments["items"][0]["id"] == "upload-garment"

    # Equal timestamps still have a deterministic order, including edited versions.
    with env.factory() as session:
        timestamp = utcnow() - timedelta(days=1)
        for asset_id in ("owner-image-asset", "owner-edit-asset"):
            session.get(Asset, asset_id).created_at = timestamp
        session.commit()
    images = env.client.get("/api/me/assets", params={"kind": "image"}).json()
    assert images["total"] == 2
    assert [item["id"] for item in images["items"]] == ["owner-image-asset", "owner-edit-asset"]
    assert all(item["source"] == "generated" and not item["in_profile"] for item in images["items"])
    assert all(item["project_id"] == "owner-project" for item in images["items"])


@pytest.mark.parametrize("params", [
    {}, {"kind": "reference"}, {"kind": "model", "limit": 0},
    {"kind": "model", "limit": 101}, {"kind": "image", "offset": -1},
])
def test_library_validates_filters_and_pagination(library_api, params):
    assert library_api.client.get("/api/me/assets", params=params).status_code == 422


def test_deleted_project_images_are_excluded(library_api):
    env = library_api
    with env.factory() as session:
        session.get(Project, "owner-project").deleted_at = utcnow()
        session.commit()
    assert env.client.get("/api/me/assets", params={"kind": "image"}).json() == {
        "items": [], "total": 0,
    }
    assert save_model(env).status_code == 404


def test_delete_model_copy_is_blocked_while_a_project_uses_it(library_api):
    env = library_api
    asset = save_model(env).json()["asset"]
    with env.factory() as session:
        copy_path = env.media / session.get(Asset, asset["id"]).path
        project = session.get(Project, "owner-project")
        project.model_asset_id = asset["id"]
        session.get(User, "owner").profile = {
            "model_asset_ids": [asset["id"], "upload-model"], "style_notes": "保留偏好",
        }
        session.commit()
    assert copy_path.exists()
    blocked = env.client.delete(f"/api/me/assets/{asset['id']}")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "ASSET_IN_USE"
    assert "操场那组" in blocked.json()["error"]["message"]
    assert copy_path.exists()
    with env.factory() as session:
        assert session.get(Project, "owner-project").model_asset_id == asset["id"]
        profile = session.get(User, "owner").profile
        assert profile["model_asset_ids"] == [asset["id"], "upload-model"]
        session.get(Project, "owner-project").deleted_at = utcnow()
        session.commit()
    response = env.client.delete(f"/api/me/assets/{asset['id']}")
    assert response.status_code == 204
    assert not copy_path.exists() and (env.media / "owner-image-asset.png").exists()
    with env.factory() as session:
        assert session.get(Asset, asset["id"]) is None
        assert session.get(User, "owner").profile == {
            "model_asset_ids": ["upload-model"], "style_notes": "保留偏好",
        }


def test_referenced_garment_conflict_lists_projects_then_allows_delete(library_api):
    env = library_api
    with env.factory() as session:
        first = session.get(Project, "owner-project")
        first.garment_asset_ids = ["upload-garment"]
        second = Project(id="reuse-project", user_id="owner", title="街头那组", brand="品牌",
                         brief="复用衣服", garment_asset_ids=["upload-garment"])
        session.add(second)
        session.commit()
    response = env.client.delete("/api/me/assets/upload-garment")
    assert response.status_code == 409
    assert all(title in response.json()["error"]["message"] for title in ("操场那组", "街头那组"))
    assert (env.media / "upload-garment.png").exists()
    with env.factory() as session:
        assert session.get(Asset, "upload-garment") is not None
        for project_id in ("owner-project", "reuse-project"):
            session.get(Project, project_id).deleted_at = utcnow()
        session.commit()
    assert env.client.delete("/api/me/assets/upload-garment").status_code == 204
    assert not (env.media / "upload-garment.png").exists()
    with env.factory() as session:
        assert session.get(Asset, "upload-garment") is None


def test_unreferenced_garment_is_deleted(library_api):
    env = library_api
    assert env.client.delete("/api/me/assets/upload-garment").status_code == 204
    assert not (env.media / "upload-garment.png").exists()
    assert env.client.get("/api/me/assets", params={"kind": "garment"}).json() == {
        "items": [], "total": 0,
    }


def test_uploaded_model_is_removed_from_profile_and_original_is_retained(library_api):
    env = library_api
    with env.factory() as session:
        session.get(User, "owner").profile = {"model_asset_ids": ["upload-model"]}
        session.get(Project, "owner-project").model_asset_id = "upload-model"
        session.commit()
    for _ in range(2):
        assert env.client.delete("/api/me/assets/upload-model").status_code == 204
    assert (env.media / "upload-model.png").exists()
    with env.factory() as session:
        assert session.get(Asset, "upload-model") is not None
        assert session.get(Project, "owner-project").model_asset_id == "upload-model"
        assert session.get(User, "owner").profile["model_asset_ids"] == []
    listing = env.client.get("/api/me/assets", params={"kind": "model"}).json()
    assert listing == {"items": [], "total": 0}
    with env.factory() as session:
        assert session.get(Asset, "upload-model").analysis["library_hidden"] is True


@pytest.mark.parametrize(("asset_id", "status"), [
    ("other-image-asset", 404), ("owner-image-asset", 409), ("missing", 404),
])
def test_delete_rejects_foreign_missing_and_project_images(library_api, asset_id, status):
    env = library_api
    assert env.client.delete(f"/api/me/assets/{asset_id}").status_code == status
    assert (env.media / "owner-image-asset.png").exists()
    assert (env.media / "other-image-asset.png").exists()


def test_reused_model_and_garment_reach_worker_as_first_reference(library_api, monkeypatch):
    env = library_api
    model = save_model(env).json()["asset"]
    created = env.client.post("/api/projects", json={
        "title": "同一个模特再拍", "brand": "品牌", "brief": "穿搭",
        "garment_asset_ids": ["upload-garment"], "model_asset_id": model["id"],
    })
    assert created.status_code == 200
    references = []
    original_image = ProviderHub.image

    def image(hub, prompt, assets):
        references.append([asset.id for asset in assets])
        return original_image(hub, prompt, assets)

    def no_http(_):
        raise AssertionError("Mock generation must not create a provider HTTP client")

    monkeypatch.setattr(ProviderHub, "image", image)
    monkeypatch.setattr(ProviderHub, "_client", no_http)
    with env.factory() as session:
        project = session.get(Project, created.json()["id"])
        workflow = Workflow(session, project)
        workflow._action_reply = lambda *args: "脚本确认了。"
        state = {"stage": "script", "script": {
            "status": "draft", "version": 1,
            "shots": [{"id": "shot-1", "scene": "操场", "pose": "站立", "camera": "全身",
                       "outfit_asset_ids": ["upload-garment"]}],
        }}
        workflow._generate_images(state, {"type": "confirm_script"})
        session.commit()
        job_id = state["job_intents"][0]["id"]
        job = session.get(Job, job_id)
        assert job.payload["reference_asset_ids"] == [model["id"], "upload-garment"]
        # Existing generated project images retain their project boundary.
        with pytest.raises(ProviderError, match="另一个项目"):
            worker._assets(session, job, ["owner-image-asset"])
        with pytest.raises(ProviderError, match="不属于当前账号"):
            worker._assets(session, job, ["other-image-asset"])
    with env.factory() as session:
        claimed = worker.claim_job(session)
        assert claimed.id == job_id
        attempt = claimed.attempts
    worker.process_job(job_id, attempt, env.factory)
    assert references == [[model["id"], "upload-garment"]]
    with env.factory() as session:
        job = session.get(Job, job_id)
        assert job.status == "succeeded", job.error
        assert (env.media / session.get(Asset, job.result_asset_id).path).is_file()


def test_saved_copy_survives_source_project_deletion_and_is_cleaned_on_account_delete(library_api):
    env = library_api
    model = save_model(env).json()["asset"]
    with env.factory() as session:
        copied_path = env.media / session.get(Asset, model["id"]).path
        cleanup_project(session, session.get(Project, "owner-project"))
    assert copied_path.exists() and not (env.media / "owner-image-asset.png").exists()
    assert env.client.get(model["url"]).status_code == 200
    with env.factory() as session:
        saved = session.get(Asset, model["id"])
        assert saved.parent_id is None and saved.project_id is None
        assert session.get(User, "owner").profile["model_asset_ids"] == [saved.id]
    created = env.client.post("/api/projects", json={
        "title": "来源删了也能用", "brand": "品牌", "brief": "穿搭",
        "garment_asset_ids": ["upload-garment"],
    })
    assert created.status_code == 200
    with env.factory() as session:
        assert session.get(Project, created.json()["id"]).model_asset_id == model["id"]
    response = env.client.request("DELETE", "/api/me", json={"password": "password-round12"})
    assert response.status_code == 204
    assert not copied_path.exists()
    assert (env.media / "other-image-asset.png").exists()
    with env.factory() as session:
        assert session.scalars(select(Asset).where(Asset.user_id == "owner")).all() == []


def test_copy_commit_failure_rolls_back_profile_and_removes_new_file(library_api):
    env = library_api
    original_files = set(env.media.iterdir())

    def reject_commit(_):
        raise RuntimeError("test commit rejected")

    event.listen(env.factory, "before_commit", reject_commit)
    try:
        assert save_model(env).status_code == 500
    finally:
        event.remove(env.factory, "before_commit", reject_commit)
    assert set(env.media.iterdir()) == original_files
    with env.factory() as session:
        assert session.get(User, "owner").profile == {}
        remaining = session.scalars(select(Asset).where(Asset.kind == "model")).one()
        assert remaining.id == "upload-model"


def test_delete_commit_failure_keeps_copy_and_profile(library_api):
    env = library_api
    model = save_model(env).json()["asset"]
    with env.factory() as session:
        path = env.media / session.get(Asset, model["id"]).path

    def reject_commit(_):
        assert path.exists(), "files must survive until the business transaction commits"
        raise RuntimeError("test commit rejected")

    event.listen(env.factory, "before_commit", reject_commit)
    try:
        assert env.client.delete(f"/api/me/assets/{model['id']}").status_code == 500
    finally:
        event.remove(env.factory, "before_commit", reject_commit)
    assert path.exists()
    with env.factory() as session:
        assert session.get(Asset, model["id"]) is not None
        assert session.get(User, "owner").profile["model_asset_ids"] == [model["id"]]
        assert session.get(AppSetting, CLEANUP_PREFIX + "asset:" + model["id"]) is None


def test_delete_file_failure_is_logged_and_retryable_after_commit(library_api, monkeypatch, caplog):
    env = library_api
    model = save_model(env).json()["asset"]
    with env.factory() as session:
        path = env.media / session.get(Asset, model["id"]).path
    original_unlink = Path.unlink

    def blocked_unlink(candidate, *args, **kwargs):
        if candidate == path:
            raise PermissionError("test file temporarily locked")
        return original_unlink(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", blocked_unlink)
    assert env.client.delete(f"/api/me/assets/{model['id']}").status_code == 204
    assert path.exists() and "清理失败" in caplog.text
    key = CLEANUP_PREFIX + "asset:" + model["id"]
    with env.factory() as session:
        assert session.get(Asset, model["id"]) is None
        assert session.get(User, "owner").profile["model_asset_ids"] == []
        assert session.get(AppSetting, key).value["paths"] == [path.name]
    monkeypatch.setattr(Path, "unlink", original_unlink)
    with env.factory() as session:
        drain_media_cleanup(session)
        assert session.get(AppSetting, key) is None
    assert not path.exists()


def test_library_routes_require_login(library_api):
    client = library_api.client
    client.headers.pop("Authorization")
    assert client.get("/api/me/assets", params={"kind": "model"}).status_code == 401
    response = client.post("/api/me/models/from-image", json={"image_id": "owner-image"})
    assert response.status_code == 401
    assert client.delete("/api/me/assets/upload-garment").status_code == 401


def test_library_lists_own_completed_videos_with_poster_and_refuses_delete(library_api):
    env = library_api
    listing = env.client.get("/api/me/assets", params={"kind": "video"}).json()
    assert listing["total"] == 1
    item = listing["items"][0]
    assert item["id"] == "owner-video-asset" and item["project_title"] == "操场那组"
    assert item["url"].startswith("http")
    assert item["poster_url"] and "owner-image-asset" in item["poster_url"]
    assert env.client.delete("/api/me/assets/owner-video-asset").status_code == 409
    with env.factory() as session:
        session.get(Project, "owner-project").deleted_at = utcnow()
        session.commit()
    assert env.client.get("/api/me/assets", params={"kind": "video"}).json()["total"] == 0
