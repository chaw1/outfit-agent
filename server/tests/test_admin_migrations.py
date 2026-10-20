import os
import subprocess
from pathlib import Path

import psycopg
import pytest


@pytest.mark.integration
def test_admin_upgrade_preserves_existing_rows_and_backfills_user(isolated_database_url):
    env = {
        **os.environ, "DATABASE_URL": isolated_database_url.render_as_string(hide_password=False)
    }
    root = Path(__file__).resolve().parents[1]

    def migrate(revision):
        result = subprocess.run(
            ["uv", "run", "alembic", "upgrade", revision], cwd=root, env=env,
            capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, result.stderr

    migrate("0003")
    connection_url = isolated_database_url.set(drivername="postgresql").render_as_string(
        hide_password=False
    )
    with psycopg.connect(connection_url) as connection:
        connection.execute(
            "INSERT INTO users(id,username,password_hash,nickname,created_at) "
            "VALUES ('legacy-user','legacy-name','unused','旧用户',now())"
        )
        connection.execute(
            "INSERT INTO projects(id,user_id,title,brand,brief,stage,garment_asset_ids,"
            "created_at,updated_at) VALUES ('legacy-project','legacy-user','旧项目','品牌',"
            "'需求','script','[]'::jsonb,now(),now())"
        )
        connection.execute(
            "INSERT INTO usage_ledger(id,project_id,model,kind,duration_ms,units,estimated_cny,"
            "status,created_at) VALUES ('legacy-ledger','legacy-project','legacy-model',"
            "'image',123,'{}'::jsonb,1.5,'succeeded',now()),"
            "('unattributed',NULL,'legacy-model','text',1,'{}'::jsonb,0,'succeeded',now())"
        )
    migrate("head")
    with psycopg.connect(connection_url) as connection:
        assert connection.execute("SELECT tier,disabled FROM users").fetchone() == ("free", False)
        assert dict(connection.execute("SELECT id,user_id FROM usage_ledger")) == {
            "legacy-ledger": "legacy-user", "unattributed": None
        }
        assert connection.execute("SELECT title FROM projects").fetchone() == ("旧项目",)
        assert connection.execute("SELECT value FROM app_settings").fetchall() == []
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("0004",)
