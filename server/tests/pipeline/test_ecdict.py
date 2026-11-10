"""ECDICT 读取端：点查（参数绑定/NOCASE）、音标规范化、释义清洗、lemma 救回。"""
from __future__ import annotations

import pytest

from app.pipeline.ecdict import (
    EcdictLookup,
    clean_translation,
    lemma_of,
    looks_inflected_only,
    normalize_phonetic,
)
from app.pipeline.errors import PipelineError


def test_lookup_missing_db_raises_hint(pipe_settings) -> None:
    with pytest.raises(PipelineError, match="preload"):
        EcdictLookup(pipe_settings.ecdict_db_path)


def test_lookup_nocache_and_miss(ecdict_db) -> None:
    lookup = EcdictLookup(ecdict_db)
    try:
        entry = lookup.lookup("HELLO")  # NOCASE：命中索引
        assert entry is not None and entry.word == "hello"
        assert lookup.lookup("zorblat") is None
    finally:
        lookup.close()


def test_normalize_phonetic_map_order() -> None:
    assert normalize_phonetic("mɒ:nɪŋ") == "mɔːnɪŋ"  # ɒ: 先于单字符替换（顺序敏感）
    assert normalize_phonetic("hә'lәʊ") == "hə'ləʊ"  # 西里尔 ә → IPA ə
    assert normalize_phonetic("bєd") == "bɛd"
    assert normalize_phonetic(None) is None  # 无音标不编造
    assert normalize_phonetic("  ") is None


def test_clean_translation_literal_newline_and_domain_lines() -> None:
    # 字面量 \n（两字符）→ 真实换行切行；[医] 领域行被裁剪
    assert clean_translation("int. 你好\\n喂") == ["int. 你好", "喂"]
    assert clean_translation("n. 早晨\\n上午\\n[医]晨间护理") == ["n. 早晨", "上午"]
    assert clean_translation("[计]域处理机") == []  # 纯领域 → 裁后无行
    assert clean_translation(None) == []


def test_inflected_detection_and_lemma() -> None:
    assert looks_inflected_only(["lick的过去式"]) is True
    assert looks_inflected_only(["vt. 舔"]) is False
    assert looks_inflected_only([]) is False
    assert lemma_of("0:lick/s:licks/d:licked/i:licking") == "lick"
    assert lemma_of("d:licked/i:licking") is None  # 只信 0: 项（06 §4）
    assert lemma_of(None) is None
