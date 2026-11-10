"""折叠投影包（spec S1/S2；票 13）：事件集 → 物化状态，与客户端 TS 折叠器同构。

导出面与 TS 侧（client/engine/src/fold.ts）对齐：fold_projection(=fold)/
sort_events/compare_events/compare_hlc。只投影不调度（S2）。
"""
from __future__ import annotations

from app.projection.fold import (
    KNOWN_EVENT_TYPES,
    apply_answer,
    apply_pool_change,
    compare_events,
    compare_hlc,
    fold_projection,
    new_card_state,
    sort_events,
)

__all__ = [
    "KNOWN_EVENT_TYPES",
    "apply_answer",
    "apply_pool_change",
    "compare_events",
    "compare_hlc",
    "fold_projection",
    "new_card_state",
    "sort_events",
]
