"""The additive auto migration backfills old projects and has a reversible schema."""

import os
import subprocess
from pathlib import Path

import psycopg
import pytest


@pytest.mark.integration
def test_auto_migration_backfills_old_rows_and_preserves_projects_on_downgrade(
    isolated_database_url,
):
    env = {
        **os.environ, "DATABASE_URL": isolated_database_url.render_as_string(hide_password=False),
    }
    root = Path(__file__).resolve().parents[1]
    connection_url = isolated_database_url.set(drivername="postgresql").render_as_string(
        hide_password=False,
    )

    def migrate(command, revision):
        result = subprocess.run(
            ["uv", "run", "alembic", command, revision], cwd=root, env=env,
            capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, result.stderr

    migrate("upgrade", "0009")
    with psycopg.connect(connection_url) as connection:
        connection.execute(
            "INSERT INTO users(id,username,password_hash,nickname,created_at) "
            "VALUES ('legacy-user','legacy-user','unused','旧用户',now())"
        )
        connection.execute(
            "INSERT INTO projects(id,user_id,title,brand,brief,stage,garment_asset_ids,"
            "created_at,updated_at) VALUES ('legacy','legacy-user','旧项目','品牌',"
            "'原文保留','direction','[]'::jsonb,now(),now())"
        )
    migrate("upgrade", "head")
    with psycopg.connect(connection_url) as connection:
        assert connection.execute(
            "SELECT mode,style_tags,brief,stage FROM projects WHERE id='legacy'"
        ).fetchone() == ("guided", [], "原文保留", "direction")
        columns = dict((name, (kind, nullable, default)) for name, kind, nullable, default in (
            connection.execute(
                "SELECT column_name,data_type,is_nullable,column_default "
                "FROM information_schema.columns WHERE table_schema='public' "
                "AND table_name='projects' AND column_name IN ('mode','style_tags')"
            )
        ))
        assert columns["mode"][0:2] == ("character varying", "NO")
        assert "guided" in columns["mode"][2]
        assert columns["style_tags"][0:2] == ("jsonb", "NO")
        assert "[]" in columns["style_tags"][2]
        connection.execute(
            "INSERT INTO projects(id,user_id,title,brand,brief,stage,garment_asset_ids,"
            "created_at,updated_at) VALUES ('new','legacy-user','新项目','品牌',"
            "'新原文','brief','[]'::jsonb,now(),now())"
        )
        assert connection.execute(
            "SELECT mode,style_tags FROM projects WHERE id='new'"
        ).fetchone() == ("guided", [])
        connection.execute(
            "UPDATE projects SET mode='auto',style_tags='[\"街头胶片\"]'::jsonb WHERE id='new'"
        )
    migrate("downgrade", "0009")
    with psycopg.connect(connection_url) as connection:
        assert dict(connection.execute("SELECT id,brief FROM projects")) == {
            "legacy": "原文保留", "new": "新原文",
        }
    migrate("upgrade", "0010")
    with psycopg.connect(connection_url) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == ("0010",)
        assert connection.execute("SELECT mode,style_tags FROM projects").fetchall() == [
            ("guided", []), ("guided", []),
        ]
