"""词形归一口径（R12 重复检测唯一口径；S7 稳定词 id 派生）。"""
from __future__ import annotations

import pytest

from app.pipeline.normalize import lexical_entry_id, normalize_word


def test_normalize_casefold_and_whitespace() -> None:
    assert normalize_word(" HELLO ") == "hello"
    assert normalize_word("Good  Bye") == "good bye"
    assert normalize_word("HELLO\thello") == "hello hello"


def test_normalize_is_the_only_dedup_key_shape() -> None:
    # 大小写/空白差异归一后相同 → 重复检测命中
    assert normalize_word("Hello") == normalize_word(" hElLo ")


def test_lexical_entry_id_deterministic_and_case_insensitive() -> None:
    assert lexical_entry_id("hello") == "w_hello"
    assert lexical_entry_id("HELLO") == "w_hello"  # 跨包一致：大小写差异同 id
    assert lexical_entry_id("good bye") == "w_good_bye"


def test_lexical_entry_id_rejects_non_word() -> None:
    with pytest.raises(ValueError):
        lexical_entry_id("   ")
