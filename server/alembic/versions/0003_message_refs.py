"""保存对话中的图片引用，历史消息默认为无引用。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "messages",
        sa.Column(
            "refs", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
    )


def downgrade():
    op.drop_column("messages", "refs")
