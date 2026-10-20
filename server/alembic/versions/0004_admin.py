"""增加管理端配置、用户层级和调用账本归属。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users", sa.Column("tier", sa.String(20), nullable=False, server_default="free")
    )
    op.add_column(
        "users", sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.add_column("usage_ledger", sa.Column("user_id", sa.String(36), nullable=True))
    op.create_foreign_key(
        "fk_usage_ledger_user_id", "usage_ledger", "users", ["user_id"], ["id"]
    )
    op.create_index("ix_usage_ledger_user_id", "usage_ledger", ["user_id"])
    op.execute(
        "UPDATE usage_ledger AS ledger SET user_id = projects.user_id "
        "FROM projects WHERE ledger.project_id = projects.id AND ledger.user_id IS NULL"
    )
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(100), primary_key=True),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("app_settings")
    op.drop_index("ix_usage_ledger_user_id", table_name="usage_ledger")
    op.drop_constraint("fk_usage_ledger_user_id", "usage_ledger", type_="foreignkey")
    op.drop_column("usage_ledger", "user_id")
    op.drop_column("users", "disabled")
    op.drop_column("users", "tier")
