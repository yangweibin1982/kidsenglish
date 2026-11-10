"""sync event envelope columns (ticket 13)

learning_events 信封化：加 type/payload 列、lexical_entry_id 放宽为可空
（daily_plan_adjusted/未知类型事件无词锚点；答题事件也不预投影——payload 即
唯一事实源）。children 加 family_id（归属校验：跨家庭 token 摸他人 child → 403）。

执行前实况（2026-10-25）：真实库 learning_events/children 均 0 行——
batch 重建为空表搬运，无数据风险。

Revision ID: a41f8c2d5e07
Revises: c33071e1a2ac
Create Date: 2026-10-25

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a41f8c2d5e07'
down_revision: Union[str, None] = 'c33071e1a2ac'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('learning_events') as batch:
        batch.add_column(
            sa.Column('type', sa.String(length=32), nullable=False, server_default='answer')
        )
        batch.add_column(sa.Column('payload', sa.JSON(), nullable=True))
        batch.alter_column('lexical_entry_id', existing_type=sa.String(length=64), nullable=True)
    with op.batch_alter_table('children') as batch:
        batch.add_column(sa.Column('family_id', sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('children') as batch:
        batch.drop_column('family_id')
    with op.batch_alter_table('learning_events') as batch:
        # 降级恢复 NOT NULL：若信封事件已产生 lexical_entry_id 为 NULL 的行则失败
        # （保数据优先，人工清理后再降级）。
        batch.alter_column('lexical_entry_id', existing_type=sa.String(length=64), nullable=False)
        batch.drop_column('payload')
        batch.drop_column('type')
