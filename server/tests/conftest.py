import os
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import psycopg
import pytest
from psycopg import sql
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.e2e import API  # noqa: E402


@pytest.fixture(scope="session")
def base_url():
    value = os.environ.get("API_BASE_URL", "http://127.0.0.1:18080").rstrip("/")
    parsed = urlsplit(value)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port in {18080, 18081}, (
        "Integration checks require this project's local Mock API on port 18080 or 18081"
    )
    try:
        response = httpx.get(f"{value}/api/health", timeout=3, trust_env=False)
        response.raise_for_status()
        assert response.json()["ok"]
        assert response.json()["providers"]["mock"] is True, (
            "pytest requires MOCK_PROVIDERS=1; use e2e.py --mode real explicitly"
        )
    except (httpx.HTTPError, KeyError) as exc:
        if os.environ.get("REQUIRE_INTEGRATION") == "1":
            pytest.fail(f"Dedicated local API is unavailable ({type(exc).__name__})")
        pytest.skip("Start this project's Mock compose stack to run integration tests")
    return value


@pytest.fixture
def api(base_url):
    client = API(base_url)
    client.register("test")
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def other_api(base_url):
    client = API(base_url)
    client.register("other")
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def project_assets(api):
    garment = api.upload("shirt.jpg", "garment")
    model = api.upload("model.jpg", "model")
    project = api.request("POST", "/api/projects", json={
        "title": "权限验证", "brand": "本地品牌", "brief": "夏季新品，想要松弛感",
        "garment_asset_ids": [garment["id"]], "model_asset_id": model["id"],
    })
    return project, garment, model


@pytest.fixture
def isolated_database_url(base_url):
    del base_url  # Only the dedicated live Mock stack permits database integration.
    url = make_url(os.environ.get(
        "TEST_DATABASE_URL", "postgresql+psycopg://outfit:outfit@localhost:18432/outfit",
    ))
    assert url.host in {"localhost", "127.0.0.1"} and url.port == 18432
    target_name = "outfit_test_" + uuid.uuid4().hex
    admin_url = url.set(drivername="postgresql").render_as_string(hide_password=False)
    created = False
    try:
        with psycopg.connect(admin_url, autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target_name)))
            created = True
        yield url.set(database=target_name)
    finally:
        if created:
            assert target_name.startswith("outfit_test_") and len(target_name) == 44
            with psycopg.connect(admin_url, autocommit=True) as connection:
                connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(target_name),
                ))
