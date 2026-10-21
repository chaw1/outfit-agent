"""模特身份卡与独立建卡任务。"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "models",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("identity_text", sa.Text(), nullable=False),
        sa.Column("face_asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=True),
        sa.Column(
            "sheet_asset_ids",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_models_user_id", "models", ["user_id"])
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("model_id", sa.String(36), nullable=True))
        batch.create_foreign_key("fk_projects_model_id", "models", ["model_id"], ["id"])
    with op.batch_alter_table("assets") as batch:
        batch.alter_column("user_id", existing_type=sa.String(36), nullable=True)
    with op.batch_alter_table("jobs") as batch:
        batch.alter_column("project_id", existing_type=sa.String(36), nullable=True)


def downgrade():
    # Remove preset assets and standalone jobs before restoring the old constraints.
    op.execute(sa.text("DELETE FROM jobs WHERE project_id IS NULL"))
    with op.batch_alter_table("projects") as batch:
        batch.drop_constraint("fk_projects_model_id", type_="foreignkey")
        batch.drop_column("model_id")
    op.drop_index("ix_models_user_id", table_name="models")
    op.drop_table("models")
    op.execute(
        sa.text(
            "UPDATE projects SET model_asset_id = NULL WHERE model_asset_id IN "
            "(SELECT id FROM assets WHERE user_id IS NULL)"
        )
    )
    op.execute(sa.text("DELETE FROM assets WHERE user_id IS NULL"))
    with op.batch_alter_table("assets") as batch:
        batch.alter_column("user_id", existing_type=sa.String(36), nullable=False)
    with op.batch_alter_table("jobs") as batch:
        batch.alter_column("project_id", existing_type=sa.String(36), nullable=False)
