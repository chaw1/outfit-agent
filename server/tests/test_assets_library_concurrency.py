"""PostgreSQL serializes personal model saves and deduplicates library pages."""

import io
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.main import app
from app.models import Asset, Base, Job, Project, User, utcnow
from app.observability import bind_session
from app.security import get_session, issue_token

pytestmark = pytest.mark.integration


@pytest.fixture
def concurrent_library(isolated_database_url, tmp_path, monkeypatch):
    engine = create_engine(
        isolated_database_url,
        connect_args={"options": "-c statement_timeout=10000 -c lock_timeout=5000"},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(settings, "mock_providers", True)
    monkeypatch.setattr(settings, "media_dir", tmp_path / "media")
    settings.media_dir.mkdir()
    output = io.BytesIO()
    Image.new("RGB", (32, 48), "white").save(output, "PNG")
    image_bytes = output.getvalue()
    timestamp = utcnow()
    with factory() as session:
        session.add(User(id="owner", username="library-race-owner", nickname="本人",
                         password_hash="unused"))
        session.flush()
        session.add(Project(id="source-project", user_id="owner", title="操场那组",
                            brand="品牌", brief="并发保存模特", garment_asset_ids=[]))
        session.flush()
        for index in range(2):
            asset_id = f"image-asset-{index}"
            relative = f"{asset_id}.png"
            (settings.media_dir / relative).write_bytes(image_bytes)
            session.add(Asset(id=asset_id, user_id="owner", project_id="source-project",
                              kind="reference", source="generated", path=relative,
                              mime="image/png", width=32, height=48, created_at=timestamp))
            session.flush()
            session.add(Job(id=f"image-job-{index}", user_id="owner",
                            project_id="source-project", kind="image" if index == 0 else "edit",
                            status="succeeded", result_asset_id=asset_id,
                            payload={"image_id": f"image-job-{index}"},
                            dedupe_key=f"image-job-{index}"))
        session.commit()

    def override_session():
        with factory() as session:
            bind_session(session)
            yield session

    previous = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = override_session
    headers = {"Authorization": "Bearer " + issue_token("owner")}
    client = TestClient(app, headers=headers, raise_server_exceptions=False)
    try:
        yield SimpleNamespace(
            client=client, factory=factory, headers=headers,
            media=settings.media_dir, image_bytes=image_bytes,
        )
    finally:
        client.close()
        if previous is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous
        engine.dispose()


def save_concurrently(env, image_ids):
    barrier = Barrier(len(image_ids))

    def save(image_id):
        client = TestClient(app, headers=env.headers, raise_server_exceptions=False)
        try:
            barrier.wait(timeout=10)
            return client.post("/api/me/models/from-image", json={"image_id": image_id})
        finally:
            client.close()

    with ThreadPoolExecutor(max_workers=len(image_ids)) as executor:
        return list(executor.map(save, image_ids))


def test_concurrent_saves_of_same_image_create_one_model_and_file(concurrent_library):
    env = concurrent_library
    existing_files = set(env.media.iterdir())
    responses = save_concurrently(env, ["image-job-0", "image-job-0"])
    assert [response.status_code for response in responses] == [200, 200], [
        response.text for response in responses
    ]
    model_ids = {response.json()["asset"]["id"] for response in responses}
    assert len(model_ids) == 1
    with env.factory() as session:
        copies = session.scalars(select(Asset).where(
            Asset.user_id == "owner", Asset.kind == "model", Asset.source == "generated",
        )).all()
        assert len(copies) == 1 and copies[0].id in model_ids
        assert copies[0].parent_id == "image-asset-0"
        assert session.get(User, "owner").profile["model_asset_ids"] == [copies[0].id]
        copied_file = env.media / copies[0].path
    assert copied_file.read_bytes() == env.image_bytes
    assert set(env.media.iterdir()) == existing_files | {copied_file}


def test_concurrent_distinct_saves_respect_twenty_model_limit(concurrent_library):
    env = concurrent_library
    with env.factory() as session:
        uploaded_ids = []
        for index in range(19):
            asset_id = f"profile-model-{index}"
            relative = f"{asset_id}.png"
            (env.media / relative).write_bytes(env.image_bytes)
            session.add(Asset(id=asset_id, user_id="owner", kind="model", source="upload",
                              path=relative, mime="image/png", width=32, height=48))
            uploaded_ids.append(asset_id)
        session.get(User, "owner").profile = {
            "model_asset_ids": uploaded_ids, "style_notes": "保留偏好",
        }
        session.commit()
    existing_files = set(env.media.iterdir())
    responses = save_concurrently(env, ["image-job-0", "image-job-1"])
    assert sorted(response.status_code for response in responses) == [200, 422], [
        response.text for response in responses
    ]
    rejected = next(response for response in responses if response.status_code == 422)
    assert rejected.json()["error"]["code"] == "MODEL_LIMIT"
    assert "20" in rejected.json()["error"]["message"]
    successful = next(response for response in responses if response.status_code == 200)
    saved_id = successful.json()["asset"]["id"]
    with env.factory() as session:
        copies = session.scalars(select(Asset).where(
            Asset.user_id == "owner", Asset.kind == "model", Asset.source == "generated",
        )).all()
        assert len(copies) == 1 and copies[0].id == saved_id
        profile = session.get(User, "owner").profile
        assert len(profile["model_asset_ids"]) == len(set(profile["model_asset_ids"])) == 20
        assert set(profile["model_asset_ids"]) == {*uploaded_ids, saved_id}
        assert profile["style_notes"] == "保留偏好"
        copied_file = env.media / copies[0].path
    assert copied_file.read_bytes() == env.image_bytes
    assert set(env.media.iterdir()) == existing_files | {copied_file}


def test_postgres_image_pages_deduplicate_jobs_and_include_edits(concurrent_library):
    env = concurrent_library
    with env.factory() as session:
        session.add(Job(id="duplicate-image-job", user_id="owner", project_id="source-project",
                        kind="image", status="succeeded", result_asset_id="image-asset-0",
                        dedupe_key="duplicate-image-job"))
        session.commit()
    pages = []
    for offset in range(3):
        response = env.client.get("/api/me/assets", params={
            "kind": "image", "limit": 1, "offset": offset,
        })
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["total"] == 2
        pages.append(page["items"])
    assert [page[0]["id"] for page in pages[:2]] == ["image-asset-1", "image-asset-0"]
    assert pages[2] == []
    assert all(page[0]["project_id"] == "source-project" for page in pages[:2])
