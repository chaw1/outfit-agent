import os
import subprocess
from pathlib import Path

import psycopg
import pytest


@pytest.mark.integration
def test_alembic_builds_an_empty_isolated_database(isolated_database_url):
    test_url = isolated_database_url
    env = {**os.environ, "DATABASE_URL": test_url.render_as_string(hide_password=False)}
    completed = subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[1], env=env,
        capture_output=True, text=True, timeout=60,
    )
    assert completed.returncode == 0, "Alembic failed on a fresh isolated database"
    with psycopg.connect(test_url.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )) as connection:
        tables = {row[0] for row in connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
        )}
        assert {"users", "projects", "assets", "messages", "jobs", "usage_ledger"} <= tables
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()
