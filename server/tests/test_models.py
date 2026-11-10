"""接缝：数据模型（spec S7）——11 概念表、锚点关系、只追加与客户端权威标记。

概念 11 表中 word_packs 按 S7 行内「含单元/包-词关联」拆为三物理表：
word_packs / word_pack_units / word_pack_entries。
"""
from __future__ import annotations

from sqlalchemy import Uuid
from sqlalchemy.sql.schema import ForeignKey, Table

from app.models import Base

CONCEPTUAL_TABLES = {
    "children",
    "lexical_entries",
    "word_versions",
    "word_packs",
    "card_pool_states",
    "learning_events",
    "game_assets",
    "import_batches",
    "session_checkpoints",
    "daily_completions",
    "sync_cursors",
}

PACK_SPLIT_TABLES = {"word_pack_units", "word_pack_entries"}


def _fk_targets(table: Table) -> set[tuple[str, str]]:
    return {
        (fk.parent.table.name, fk.column.table.name)  # type: ignore[attr-defined]
        for fk in table.foreign_keys
    }


def test_all_conceptual_tables_exist() -> None:
    present = set(Base.metadata.tables)

    assert CONCEPTUAL_TABLES <= present, f"缺表: {CONCEPTUAL_TABLES - present}"
    assert present == CONCEPTUAL_TABLES | PACK_SPLIT_TABLES, (
        f"多表: {present - CONCEPTUAL_TABLES - PACK_SPLIT_TABLES}"
    )


def test_progress_anchors_pin_lexical_entries_not_word_versions() -> None:
    """进度锚点 = lexical_entries 稳定词 id（钉到 word_versions 即 WRONG）。"""
    pool_fk = _fk_targets(Base.metadata.tables["card_pool_states"])
    event_fk = _fk_targets(Base.metadata.tables["learning_events"])

    assert ("card_pool_states", "lexical_entries") in pool_fk
    assert ("learning_events", "lexical_entries") in event_fk
    # 进度面不得直接引用词内容行
    assert ("card_pool_states", "word_versions") not in pool_fk
    assert ("learning_events", "word_versions") not in event_fk


def test_pack_word_association_pins_word_versions() -> None:
    """包-词关联锚定词内容行 id（word_versions）。"""
    entry_fk = _fk_targets(Base.metadata.tables["word_pack_entries"])

    assert ("word_pack_entries", "word_versions") in entry_fk


def test_learning_events_pk_is_uuid_and_append_only() -> None:
    table = Base.metadata.tables["learning_events"]

    assert isinstance(table.columns["event_id"].type, Uuid)
    assert table.columns["event_id"].primary_key
    assert table.info.get("append_only") is True


def test_card_pool_states_is_client_authoritative_and_unique_per_child_word() -> None:
    table = Base.metadata.tables["card_pool_states"]

    assert table.info.get("client_authoritative") is True
    unique_sets = {
        tuple(col.name for col in constraint.columns)
        for constraint in table.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }
    assert ("child_id", "lexical_entry_id") in unique_sets


def test_word_versions_reference_lexical_entries() -> None:
    """词内容行挂在稳定词 id 之下（包版本不可变引用内容行）。"""
    version_fk = _fk_targets(Base.metadata.tables["word_versions"])

    assert ("word_versions", "lexical_entries") in version_fk


def test_auxiliary_tables_unique_keys() -> None:
    def unique_sets(name: str) -> set[tuple[str, ...]]:
        table = Base.metadata.tables[name]
        return {
            tuple(col.name for col in constraint.columns)
            for constraint in table.constraints
            if constraint.__class__.__name__ == "UniqueConstraint"
        }

    assert ("device_id", "child_id") in unique_sets("sync_cursors")
    assert ("child_id", "day") in unique_sets("session_checkpoints")
    assert ("child_id", "day") in unique_sets("daily_completions")
    assert ("child_id",) in unique_sets("game_assets")


def test_children_daily_new_words_bounded_3_to_10() -> None:
    """R4：每日新词数家长可调 3-10，落库层即约束。"""
    checks = {
        constraint.sqltext
        for constraint in Base.metadata.tables["children"].constraints
        if constraint.__class__.__name__ == "CheckConstraint"
    }

    assert any("daily_new_words" in str(sql) for sql in checks)


def test_pack_versions_immutable_content_marker() -> None:
    """词包版本化不可变（S1）：包行与内容行带不可变标记。"""
    assert Base.metadata.tables["word_packs"].info.get("immutable_versions") is True
    assert Base.metadata.tables["word_versions"].info.get("immutable_content") is True
