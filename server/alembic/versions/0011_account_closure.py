"""增加账号同意记录、恢复码与账号注销状态。"""

import sqlalchemy as sa

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("legal_version", sa.String(40), nullable=True))
    op.add_column("users", sa.Column("legal_agreed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("recovery_code_hash", sa.Text(), nullable=True))
    op.add_column("users", sa.Column(
        "password_updated_at", sa.DateTime(timezone=True), nullable=True,
    ))
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    for column in (
        "deleted_at", "password_updated_at", "recovery_code_hash",
        "legal_agreed_at", "legal_version",
    ):
        op.drop_column("users", column)
