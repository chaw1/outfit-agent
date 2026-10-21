"""Personal-library lifecycle through the live local Mock API and generation Worker."""

import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from sqlalchemy import create_engine, or_, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models import Asset, Job, Project, User
from scripts.e2e import API, ROOT

pytestmark = pytest.mark.integration


@pytest.fixture
def live_library(base_url):
    url = make_url(os.environ.get(
        "TEST_DATABASE_URL", "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
    ))
    assert url.host in {"127.0.0.1", "localhost"} and url.port == 18432
    default_media = ROOT / "data" / (
        "round12-media" if urlsplit(base_url).port == 18081 else "media"
    )
    media = Path(os.environ.get("MEDIA_DIR", str(default_media))).resolve()
    assert media.is_relative_to(ROOT / "data"), "Use this worktree's local media directory"
    # 只有 README 里的独立本机 API（18081）与测试共用 MEDIA_DIR；compose 栈的媒体目录在容器里。
    shared_media = urlsplit(base_url).port == 18081
    engine = create_engine(url)
    accounts = []

    def register():
        client = API(base_url)
        credentials, user = client.register("library")
        accounts.append((client, credentials))
        with Session(engine) as session:
            assert session.get(User, user["id"]) is not None, "API and test DB must match"
        return SimpleNamespace(api=client, credentials=credentials, user=user)

    try:
        yield SimpleNamespace(
            register=register, engine=engine, media=media, shared_media=shared_media,
        )
    finally:
        for client, credentials in accounts:
            try:
                response = client.client.request(
                    "DELETE", "/api/me", json={"password": credentials["password"]},
                )
                assert response.status_code in {204, 401}
            finally:
                client.close()
        engine.dispose()


def new_project(api, garment_id, title, **extra):
    return api.request("POST", "/api/projects", json={
        "title": title, "brand": "本地素材库回归", "brief": "夏季新品，想要松弛感",
        "garment_asset_ids": [garment_id], **extra,
    })


def generate_images(api, project_id):
    api.send(project_id, text="夏季新品，想要松弛感")
    state = api.wait(project_id, lambda item: not item["active_jobs"], timeout=90, poll=0.2)
    assert state["directions"]
    api.send(project_id, action={
        "type": "choose_direction", "direction_id": state["directions"][0]["id"],
    })
    shot_count = len(api.state(project_id)["script"]["shots"])
    assert shot_count > 0
    api.send(project_id, action={"type": "confirm_script"})
    return api.wait(project_id, lambda item: (
        len([image for image in item["images"] if image["version"] == 1]) == shot_count
        and not item["active_jobs"]
        and all(image["status"] == "succeeded" for image in item["images"])
    ), timeout=90, poll=0.2)


def file_for(env, user_id, asset_id):
    with Session(env.engine) as session:
        asset = session.get(Asset, asset_id)
        assert asset is not None and asset.user_id == user_id
        path = (env.media / asset.path).resolve()
        assert path.is_relative_to(env.media)
        if not path.is_file():
            if env.shared_media:
                raise AssertionError(f"共用媒体目录下应有这个文件：{path}")
            pytest.skip(
                "这两条用例要求 API 与测试共用本机 MEDIA_DIR（compose 栈的媒体目录在容器里）；"
                "用 README 里的独立本机 API（18081）运行即可覆盖"
            )
        return path


def library_items(api, kind, **pagination):
    return api.request("GET", "/api/me/assets", params={"kind": kind, **pagination})


def test_saved_model_generates_in_another_project_and_survives_source_deletion(live_library):
    env = live_library
    owner, other = env.register(), env.register()
    api = owner.api
    garment = api.upload("shirt.jpg", "garment")
    uploaded_model = api.upload("model.jpg", "model")
    source = new_project(api, garment["id"], "操场来源组片", model_asset_id=uploaded_model["id"])
    state = generate_images(api, source["id"])
    original = state["images"][0]
    saved = api.request("POST", "/api/me/models/from-image", json={
        "image_id": original["id"], "name": "操场那组的她",
    })
    model = saved["asset"]
    assert (model["kind"], model["source"], model["name"]) == (
        "model", "generated", "操场那组的她",
    )
    assert model["project_id"] == source["id"] and model["project_title"] == source["title"]
    assert model["in_profile"] is True
    assert saved["user"]["profile"]["model_asset_ids"] == [model["id"]]
    with Session(env.engine) as session:
        original_job = session.scalar(select(Job).where(
            Job.project_id == source["id"], or_(
                Job.id == original["id"], Job.payload["image_id"].as_string() == original["id"],
            ),
        ))
        assert original_job is not None and original_job.status == "succeeded"
        assert model["parent_id"] == original_job.result_asset_id
    copy_path = file_for(env, owner.user["id"], model["id"])
    original_path = file_for(env, owner.user["id"], model["parent_id"])
    assert copy_path != original_path and copy_path.read_bytes() == original_path.read_bytes()
    again = api.request("POST", "/api/me/models/from-image", json={
        "image_id": model["parent_id"], "name": "重复保存保持原名字",
    })
    assert again["asset"]["id"] == model["id"]
    assert again["asset"]["name"] == model["name"]
    assert again["user"]["profile"]["model_asset_ids"] == [model["id"]]
    denied = other.api.client.post("/api/me/models/from-image", json={
        "image_id": original["id"],
    })
    assert denied.status_code == 404

    profile = api.request("PATCH", "/api/me", json={"profile": {
        "model_asset_ids": [model["id"], uploaded_model["id"]],
    }})
    assert profile["profile"]["model_asset_ids"][0] == model["id"]
    reused = new_project(api, garment["id"], "复用模特和衣服的组片")
    with Session(env.engine) as session:
        reused_project = session.get(Project, reused["id"])
        assert reused_project.model_asset_id == model["id"]
        assert reused_project.garment_asset_ids == [garment["id"]]
    reused_state = generate_images(api, reused["id"])
    assert reused_state["images"]
    with Session(env.engine) as session:
        assert session.get(Project, source["id"]).deleted_at is None
        jobs = session.scalars(select(Job).where(
            Job.project_id == reused["id"], Job.kind == "image",
        )).all()
        assert jobs and any(job.payload.get("purpose") != "preview" for job in jobs)
        assert all(job.status == "succeeded" for job in jobs)
        assert all(job.payload["reference_asset_ids"][0] == model["id"] for job in jobs)
    in_use = api.client.delete(f"/api/me/assets/{garment['id']}")
    assert in_use.status_code == 409
    assert all(title in in_use.json()["error"]["message"] for title in (
        source["title"], reused["title"],
    ))

    assert api.client.delete(f"/api/projects/{source['id']}").status_code == 204
    assert not original_path.exists() and copy_path.is_file()
    retained = next(item for item in library_items(api, "model")["items"]
                    if item["id"] == model["id"])
    downloaded = api.client.get(retained["url"])
    assert downloaded.status_code == 200 and downloaded.content == copy_path.read_bytes()
    assert api.request("GET", f"/api/projects/{reused['id']}")["id"] == reused["id"]
    with Session(env.engine) as session:
        assert session.get(Project, reused["id"]).model_asset_id == model["id"]
    assert api.request("GET", "/api/me")["profile"]["model_asset_ids"][0] == model["id"]
    response = api.client.request("DELETE", "/api/me", json={
        "password": owner.credentials["password"],
    })
    assert response.status_code == 204
    assert not copy_path.exists(), "Account deletion must physically remove the saved model copy"
    with Session(env.engine) as session:
        assert session.get(Asset, model["id"]) is None


def test_library_lists_real_edited_images_and_deletes_reusable_files(live_library):
    env = live_library
    owner = env.register()
    api = owner.api
    garment = api.upload("shirt.jpg", "garment")
    unused_garment = api.upload("jeans.jpg", "garment")
    uploaded_model = api.upload("model.jpg", "model")
    project = new_project(api, garment["id"], "素材列表与改图", model_asset_id=uploaded_model["id"])
    state = generate_images(api, project["id"])
    original = state["images"][0]
    instruction = "把袖口放下来，保持人物和场景不变"
    api.send(project["id"], action={
        "type": "edit_image", "image_id": original["id"], "instruction": instruction,
    })
    state = api.wait(project["id"], lambda item: (
        not item["active_jobs"] and any(image["instruction"] == instruction
                                       for image in item["images"])
    ), timeout=90, poll=0.2)
    saved = api.request("POST", "/api/me/models/from-image", json={"image_id": original["id"]})
    model = saved["asset"]
    assert model["name"] == project["title"]
    api.request("PATCH", "/api/me", json={"profile": {
        "model_asset_ids": [model["id"], uploaded_model["id"]],
    }})

    models = library_items(api, "model")
    assert models["total"] == 2
    assert {item["id"] for item in models["items"]} == {model["id"], uploaded_model["id"]}
    assert all(item["in_profile"] for item in models["items"])
    assert {item["source"] for item in models["items"]} == {"upload", "generated"}
    garments = library_items(api, "garment")
    assert garments["total"] == 2
    assert {item["id"] for item in garments["items"]} == {garment["id"], unused_garment["id"]}
    assert all(item["project_id"] is None and item["project_title"] is None
               and item["in_profile"] is False for item in garments["items"])
    images = library_items(api, "image")
    with Session(env.engine) as session:
        jobs = session.scalars(select(Job).where(
            Job.project_id == project["id"], Job.kind.in_(["image", "edit"]),
            Job.status == "succeeded",
        )).all()
        finals = {job.result_asset_id for job in jobs if job.payload.get("purpose") != "preview"}
        edited = {job.result_asset_id for job in jobs if job.kind == "edit"}
    assert edited and images["total"] == len(finals)
    assert {item["id"] for item in images["items"]} == finals
    assert edited <= {item["id"] for item in images["items"]}
    assert all(item["project_title"] == project["title"] and not item["in_profile"]
               for item in images["items"])
    assert [item["created_at"] for item in images["items"]] == sorted(
        (item["created_at"] for item in images["items"]), reverse=True,
    )
    pages = [library_items(api, "image", limit=2, offset=offset)
             for offset in range(0, images["total"] + 2, 2)]
    assert all(page["total"] == images["total"] for page in pages)
    assert [item["id"] for page in pages for item in page["items"]] == [
        item["id"] for item in images["items"]
    ]

    copy_path = file_for(env, owner.user["id"], model["id"])
    assert api.client.delete(f"/api/me/assets/{model['id']}").status_code == 204
    assert not copy_path.exists()
    assert model["id"] not in api.request("GET", "/api/me")["profile"]["model_asset_ids"]
    with Session(env.engine) as session:
        assert session.get(Asset, model["id"]) is None
    unused_path = file_for(env, owner.user["id"], unused_garment["id"])
    assert api.client.delete(f"/api/me/assets/{unused_garment['id']}").status_code == 204
    assert not unused_path.exists()
    blocked = api.client.delete(f"/api/me/assets/{garment['id']}")
    assert blocked.status_code == 409 and project["title"] in blocked.json()["error"]["message"]
    assert api.client.delete(f"/api/me/assets/{images['items'][0]['id']}").status_code == 409
