"""缓存衣服看图结果，避免重放时重复调用。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("assets", sa.Column("analysis", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("assets", "analysis")
