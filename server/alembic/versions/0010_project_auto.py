"""增加项目创作模式与风格词，已有项目继续逐步确认。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("projects", sa.Column(
        "mode", sa.String(20), nullable=False, server_default="guided",
    ))
    op.add_column("projects", sa.Column(
        "style_tags", postgresql.JSONB(), nullable=False, server_default="[]",
    ))


def downgrade():
    op.drop_column("projects", "style_tags")
    op.drop_column("projects", "mode")
