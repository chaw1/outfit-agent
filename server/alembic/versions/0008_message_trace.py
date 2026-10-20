"""增加回复过程与文字重写标记。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("messages", sa.Column("trace", postgresql.JSONB(), nullable=True))
    op.add_column("messages", sa.Column(
        "can_regenerate", sa.Boolean(), nullable=False, server_default=sa.false(),
    ))


def downgrade():
    op.drop_column("messages", "can_regenerate")
    op.drop_column("messages", "trace")
