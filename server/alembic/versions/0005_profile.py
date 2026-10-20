"""为博主保存本人照片和穿搭偏好。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("profile", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade():
    op.drop_column("users", "profile")
