"""词形归一（R12 重复检测唯一口径）：大小写与空白归一，供重复检测与稳定词 id 派生。

口径：casefold＋空白折叠为单空格＋去首尾空白（票面：大小写/空格归一）。
不做词干化——保持词形身份稳定（lexical_entries 锚点语义，spec S7）。
"""
from __future__ import annotations

import re

_NON_ID = re.compile(r"[^a-z0-9]+")


def normalize_word(word: str) -> str:
    """归一化词形：大小写不敏感、空白折叠。重复检测唯一口径（勿在他处另写）。"""
    return " ".join(word.split()).casefold()


def lexical_entry_id(word: str) -> str:
    """稳定词 id：由归一化词形确定性派生（跨包一致，重复导入幂等复用，spec S7）。

    进度锚点钉在 lexical_entries（S7 铁律）：id 必须只由词形决定，
    与包版本/批次无关，否则进度跨包漂移。
    """
    slug = _NON_ID.sub("_", normalize_word(word)).strip("_")
    if not slug:
        raise ValueError(f"无法派生稳定词 id（词形不含字母数字）：{word!r}")
    return f"w_{slug}"
