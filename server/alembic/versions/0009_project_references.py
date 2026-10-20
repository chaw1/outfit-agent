"""增加项目参考图，已有项目默认不使用参考图。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("projects", sa.Column(
        "reference_asset_ids", postgresql.JSONB(), nullable=False, server_default="[]",
    ))


def downgrade():
    op.drop_column("projects", "reference_asset_ids")
