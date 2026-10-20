"""Persist completed HTTP request counts across API processes and restarts."""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "request_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("request_id", sa.String(128), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=True),
        sa.Column("project_id", sa.String(128), nullable=True),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("route", sa.String(200), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("is_error", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_request_events_created_at", "request_events", ["created_at"])


def downgrade():
    op.drop_index("ix_request_events_created_at", table_name="request_events")
    op.drop_table("request_events")
