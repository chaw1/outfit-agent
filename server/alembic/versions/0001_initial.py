"""创建账号、项目、媒体、对话、任务队列及调用账本。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def identity():
    return sa.Column("id", sa.String(36), primary_key=True)


def created():
    return sa.Column("created_at", sa.DateTime(timezone=True), nullable=False)


def updated():
    return sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False)


def upgrade():
    op.create_table(
        "users",
        identity(),
        sa.Column("username", sa.String(32), nullable=False, unique=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("nickname", sa.String(80), nullable=False),
        created(),
    )
    op.create_table(
        "assets",
        identity(),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("mime", sa.String(80), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("parent_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("model", sa.String(100), nullable=True),
        created(),
    )
    op.create_index("ix_assets_user_id", "assets", ["user_id"])
    op.create_index("ix_assets_project_id", "assets", ["project_id"])
    op.create_table(
        "projects",
        identity(),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("brand", sa.String(200), nullable=False),
        sa.Column("brief", sa.Text(), nullable=False),
        sa.Column("stage", sa.String(20), nullable=False),
        sa.Column("garment_asset_ids", postgresql.JSONB(), nullable=False),
        sa.Column("model_asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=True),
        created(),
        updated(),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"])
    op.create_table(
        "messages",
        identity(),
        sa.Column("project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("cards", postgresql.JSONB(), nullable=False),
        sa.Column("action", postgresql.JSONB(), nullable=True),
        created(),
    )
    op.create_index("ix_messages_project_id", "messages", ["project_id"])
    op.create_table(
        "jobs",
        identity(),
        sa.Column("project_id", sa.String(36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=False),
        sa.Column("result_asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("dedupe_key", sa.String(200), nullable=False, unique=True),
        created(),
        updated(),
    )
    op.create_index("ix_jobs_user_id", "jobs", ["user_id"])
    op.create_index("ix_jobs_project_id", "jobs", ["project_id"])
    op.create_index("ix_jobs_queue", "jobs", ["status", "available_at", "created_at"])
    op.create_table(
        "usage_ledger",
        identity(),
        sa.Column("project_id", sa.String(36), nullable=True),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("units", postgresql.JSONB(), nullable=False),
        sa.Column("estimated_cny", sa.Numeric(12, 6), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        created(),
    )
    op.create_index("ix_usage_ledger_project_id", "usage_ledger", ["project_id"])


def downgrade():
    for table in ("usage_ledger", "jobs", "messages", "projects", "assets", "users"):
        op.drop_table(table)
