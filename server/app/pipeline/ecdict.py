"""ECDICT 只读补全源（spec S3；导入参数由 06 号尽调报告实测锁定）。

- 库文件＝server/data/ecdict/ecdict.db（preload.py 独立建库，安装期独占执行，运行期只读）。
- 查询一律参数绑定（安全硬约束）；word 列 COLLATE NOCASE 索引（06 §7，点查 0.127ms）。
- 三个导入坑对策（06 §0/§4）：字面量 ``\\n`` 换行（预载期已替换，读取端兜底再替换一次）、
  领域行（[计]/[医] 等）裁剪、屈折词 exchange 0:lemma 救回。
- 音标非标准字符映射规范化（06 §4 码点核验）：西里尔 ә/є → IPA ə/ɛ，ɒ: → ɔː。
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from app.pipeline.errors import PipelineError

# 顺序敏感：先替换带冒号的 ɒ:，再替换单字符（dict 保序）
_PHONETIC_MAP = {
    "ɒ:": "ɔː",
    "ә": "ə",  # U+04D9 西里尔 schwa → IPA ə U+0259
    "є": "ɛ",  # U+0454 西里尔 → IPA ɛ U+025B
}

# 屈折释义形如「take 的过去式」→ 无独立义项，须跳 lemma 复查（06 §4）
_INFLECTION_RE = re.compile(r"^[A-Za-z\-''']{1,40}的(?:过去式|过去分词|现在分词|复数|第三人称单数)$")

# 领域标注行：以 [计]/[医]/[网络] 等开头（06 §4：裁剪规则＝丢弃以 [xx] 开头的行）
DOMAIN_LINE_RE = re.compile(r"^\[[^\]]{1,10}\]")


@dataclass(frozen=True)
class EcdictEntry:
    """ecdict 表一行（预载保留列：弃 detail/audio/pos，06 §7）。"""

    word: str
    phonetic: str | None
    translation: str | None
    definition: str | None
    exchange: str | None


def normalize_phonetic(phonetic: str | None) -> str | None:
    """音标字符规范化（06 §4：ә→ə、є→ɛ、ɒ:→ɔː）。无音标返回 None，不编造。"""
    if not phonetic:
        return None
    text = phonetic.strip()
    for source, target in _PHONETIC_MAP.items():
        text = text.replace(source, target)
    return text or None


def clean_translation(translation: str | None) -> list[str]:
    """释义清洗：字面量 \\n 兜底替换 → 真实换行切行 → 丢 [领域] 行 → 去空行。

    裁后无行（纯领域释义，全库 0.8%）由调用方判为查无（06 §7）。
    """
    if not translation:
        return []
    text = translation.replace("\\n", "\n")  # 两字符字面量 → 真实换行（预载已换，此处兜底）
    lines = [line.strip() for line in text.splitlines()]
    return [line for line in lines if line and not DOMAIN_LINE_RE.match(line)]


def looks_inflected_only(lines: list[str]) -> bool:
    """全部义项行都是「xx 的过去式/复数/…」形态 → 该词条无独立义项。"""
    return bool(lines) and all(_INFLECTION_RE.match(line) for line in lines)


def lemma_of(exchange: str | None) -> str | None:
    """取 exchange 的 0:lemma（06 §4：只信 0: 项，d:/3: 等噪音不取）。"""
    if not exchange:
        return None
    for part in exchange.split("/"):
        item = part.strip()
        if item.startswith("0:"):
            return item[2:].strip() or None
    return None


class EcdictLookup:
    """只读点查（URI mode=ro 强制只读；参数绑定；NOCASE 命中索引）。"""

    _SQL_LOOKUP = (
        "SELECT word, phonetic, translation, definition, exchange "
        "FROM ecdict WHERE word = ? COLLATE NOCASE LIMIT 1"
    )

    def __init__(self, db_path: str | Path) -> None:
        path = Path(db_path)
        if not path.exists():
            raise PipelineError(
                f"ECDICT 库未预载（{path}）。请先执行：python -m app.pipeline.preload"
            )
        path = path.resolve()  # as_uri 要求绝对路径（CLI 允许相对 --data-dir）
        try:
            # mode=ro：运行期只读（spec S3）；as_uri 对路径特殊字符百分号编码
            self._conn = sqlite3.connect(
                path.as_uri() + "?mode=ro", uri=True, check_same_thread=False
            )
            self._conn.execute("SELECT 1")  # 即时探活
        except sqlite3.Error as exc:
            raise PipelineError(f"ECDICT 库打开失败（{path}）：{exc}") from exc

    def lookup(self, word: str) -> EcdictEntry | None:
        """点查一词（参数绑定）；查无返回 None——调用方必须走 E7 待补路径，禁编造。"""
        row = self._conn.execute(self._SQL_LOOKUP, (word,)).fetchone()
        if row is None:
            return None
        return EcdictEntry(
            word=row[0], phonetic=row[1], translation=row[2], definition=row[3], exchange=row[4]
        )

    def close(self) -> None:
        self._conn.close()
