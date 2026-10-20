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
        assert {
            "users", "projects", "assets", "messages", "jobs", "usage_ledger",
            "request_events", "rate_limit_counters",
        } <= tables
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("0008",)
        refs = connection.execute(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='messages' AND column_name='refs'",
        ).fetchone()
        assert refs[0:2] == ("jsonb", "NO")
        assert "[]" in refs[2]
        trace = connection.execute(
            "SELECT data_type, is_nullable FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='messages' AND column_name='trace'",
        ).fetchone()
        assert trace == ("jsonb", "YES")
        can_regenerate = connection.execute(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='messages' "
            "AND column_name='can_regenerate'",
        ).fetchone()
        assert can_regenerate == ("boolean", "NO", "false")
