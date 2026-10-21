"""Studio metadata is private, validated and ordered without changing content recency."""

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from app.main import app
from app.models import Base, Project, User
from app.security import get_session, issue_token


@pytest.fixture
def studio_api(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'studio.sqlite'}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        owner = User(id="owner", username="studio-owner", password_hash="unused", nickname="本人")
        other = User(id="other", username="studio-other", password_hash="unused", nickname="他人")
        session.add_all([owner, other])
        session.flush()
        for index, (project_id, owner_id, pinned) in enumerate(
            [
                ("old-pin", owner.id, True),
                ("old", owner.id, False),
                ("new-pin", owner.id, True),
                ("new", owner.id, False),
                ("foreign", other.id, False),
                ("deleted", owner.id, False),
            ]
        ):
            timestamp = datetime(2026, 10, 1, tzinfo=UTC) + timedelta(days=index)
            session.add(
                Project(
                    id=project_id,
                    user_id=owner_id,
                    title=project_id,
                    brand="个人品牌",
                    brief="不改内容",
                    garment_asset_ids=[],
                    pinned=pinned,
                    created_at=timestamp,
                    updated_at=timestamp,
                    deleted_at=timestamp if project_id == "deleted" else None,
                )
            )
        session.commit()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    client = TestClient(app, headers={"Authorization": "Bearer " + issue_token("owner")})
    try:
        yield client, engine
    finally:
        client.close()
        app.dependency_overrides.pop(get_session, None)
        engine.dispose()


def test_patch_title_and_pin_preserves_content_and_recency(studio_api):
    client, _ = studio_api
    before = client.get("/api/projects/old").json()
    response = client.patch("/api/projects/old", json={"title": "  新片场 🧵  ", "pinned": True})
    assert response.status_code == 200
    after = response.json()
    assert after["title"] == "新片场 🧵"
    assert after["pinned"] is True
    assert after["updated_at"] == before["updated_at"]
    assert after["brief"] == before["brief"]
    assert client.get("/api/projects/old").json() == after
    assert (
        client.patch("/api/projects/old", json={"pinned": False}).json()["title"] == after["title"]
    )
    assert client.patch("/api/projects/old", json={}).status_code == 200
    assert client.patch("/api/projects/old", json={"title": "衣" * 40}).status_code == 200
    assert client.patch("/api/projects/old", json={"title": "🧵" * 40}).status_code == 200
    assert client.patch("/api/projects/old", json={"title": "衣"}).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"title": ""},
        {"title": " \n "},
        {"title": "衣" * 41},
        {"title": None},
        {"title": 12},
        {"pinned": None},
        {"pinned": "true"},
        {"pinned": 1},
        {"brief": "不应被修改"},
    ],
)
def test_patch_rejects_invalid_metadata_atomically(studio_api, body):
    client, _ = studio_api
    before = client.get("/api/projects/old").json()
    assert client.patch("/api/projects/old", json=body).status_code == 422
    assert client.get("/api/projects/old").json() == before


@pytest.mark.parametrize("project_id", ["foreign", "missing", "deleted"])
def test_patch_never_modifies_foreign_missing_or_deleted_projects(studio_api, project_id):
    client, engine = studio_api
    assert (
        client.patch(
            f"/api/projects/{project_id}", json={"title": "越权", "pinned": True}
        ).status_code
        == 404
    )
    with Session(engine) as session:
        project = session.get(Project, project_id)
        if project:
            assert project.title == project_id
            assert project.pinned is False


def test_pinned_projects_sort_first_with_recency_preserved_inside_both_groups(studio_api):
    client, _ = studio_api

    def ids():
        response = client.get("/api/projects")
        assert response.status_code == 200
        assert all(isinstance(project["pinned"], bool) for project in response.json())
        return [project["id"] for project in response.json()]

    assert ids() == ["new-pin", "old-pin", "new", "old"]
    assert client.patch("/api/projects/old", json={"pinned": True}).status_code == 200
    assert ids() == ["new-pin", "old", "old-pin", "new"]
    assert client.patch("/api/projects/old", json={"pinned": False}).status_code == 200
    assert ids() == ["new-pin", "old-pin", "new", "old"]


def test_pin_migration_backfills_old_projects_and_downgrades_without_data_loss():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0012_project_pinned.py"
    spec = importlib.util.spec_from_file_location("pin_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "0011"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT)"))
        connection.execute(text("INSERT INTO projects VALUES ('legacy', '旧片场')"))
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            module.upgrade()
            assert connection.execute(text("SELECT title, pinned FROM projects")).one() == (
                "旧片场",
                0,
            )
            connection.execute(text("INSERT INTO projects (id, title) VALUES ('new', '新片场')"))
            assert (
                connection.execute(text("SELECT pinned FROM projects WHERE id='new'")).scalar() == 0
            )
            module.downgrade()
            assert "pinned" not in {
                column["name"] for column in inspect(connection).get_columns("projects")
            }
            assert connection.execute(
                text("SELECT title FROM projects ORDER BY id")
            ).scalars().all() == ["旧片场", "新片场"]
    engine.dispose()
