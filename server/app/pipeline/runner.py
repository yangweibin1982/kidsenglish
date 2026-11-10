"""导入流水线编排（spec S3：双入口共用管线；本票接 CLI，HTTP API 归后续票）。

批次状态机（S7 import_batches）：uploaded → enriched → preview → committed / failed。
- import_xlsx：读 xlsx → 批内/库内重复检测（词形归一）→ ECDICT 补全 → 预览快照落盘
  （data/imports/batch_{id}_preview.json；commit 以快照为准，xlsx 中途变更不影响）。
- commit_batch：入库（lexical_entries 稳定 id 复用＋word_versions 新行）→
  official 词包版本化发布（四级组织＋manifest 逐文件 SHA-256；同版本重发＝拒绝）。

安全硬约束：全部 DB 访问走 SQLAlchemy ORM 参数绑定；无任何字符串拼接 SQL。
"""
from __future__ import annotations

import json
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    ImportBatch,
    LexicalEntry,
    WordPack,
    WordPackEntry,
    WordPackUnit,
    WordVersion,
)
from app.pipeline.ecdict import EcdictLookup
from app.pipeline.enrich import WordEnricher
from app.pipeline.errors import PackImmutabilityError, PipelineError
from app.pipeline.normalize import lexical_entry_id, normalize_word
from app.pipeline.pack import bundle_dir, verify_bundle, write_bundle

# 可入包状态：ok＝ECDICT 命中；dup_in_db＝库内已有词条（复用稳定 id，仍建本包内容行）
PACKABLE_STATUS = ("ok", "dup_in_db")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _preview_path(settings, batch_id: int) -> Path:
    return settings.imports_dir / f"batch_{batch_id}_preview.json"


def import_xlsx(
    session: Session,
    settings,
    xlsx_path: str | Path,
    *,
    source: str,
    series: str,
) -> dict:
    """三列 xlsx → 补全 → 预览（E7 查无标黄进待补队列）；返回预览 payload。"""
    from app.pipeline.xlsx_io import read_words_xlsx

    path = Path(xlsx_path)
    if not path.exists():
        raise PipelineError(f"xlsx 不存在：{path}")
    rows = read_words_xlsx(path)
    if not rows:
        raise PipelineError("xlsx 无数据行")

    identities = {(row.grade, row.term) for row in rows}
    if len(identities) > 1:
        raise PipelineError(
            f"一个批次仅支持一个「年级+学期」，读到 {sorted(identities)}；请按册拆分文件"
        )
    grade, term = next(iter(identities))

    batch = ImportBatch(source=source, file_ref=str(path), status="uploaded")
    session.add(batch)
    session.flush()  # 取 batch.id

    lookup = EcdictLookup(settings.ecdict_db_path)
    enricher = WordEnricher(lookup)
    try:
        seen: dict[str, int] = {}  # 归一化词形 → 首现行号（批内去重）
        ordinals: Counter = Counter()  # 单元内序号
        unit_titles: dict[int, str | None] = {}
        preview_rows: list[dict] = []
        pending_queue: list[dict] = []

        for row in rows:
            normalized = normalize_word(row.word)
            if normalized in seen:
                preview_rows.append(
                    {
                        "row_no": row.row_no,
                        "unit_no": row.unit_no,
                        "word": row.word,
                        "status": "dup_in_batch",
                        "duplicate_of_row": seen[normalized],
                    }
                )
                continue
            seen[normalized] = row.row_no

            entry_id = lexical_entry_id(row.word)
            duplicate_in_db = session.get(LexicalEntry, entry_id) is not None
            enriched = enricher.enrich(row.word)

            if enriched.status == "missing":
                pending_queue.append(
                    {
                        "row_no": row.row_no,
                        "word": row.word,
                        "reason": enriched.miss_reason,
                        "grade": grade,
                        "term": term,
                        "unit_no": row.unit_no,
                    }
                )
                preview_rows.append(
                    {
                        "row_no": row.row_no,
                        "unit_no": row.unit_no,
                        "word": row.word,
                        "status": "missing",
                        "reason": enriched.miss_reason,
                    }
                )
                continue

            if row.unit_no not in unit_titles or unit_titles[row.unit_no] is None:
                unit_titles[row.unit_no] = row.unit_title
            ordinals[row.unit_no] += 1
            preview_rows.append(
                {
                    "row_no": row.row_no,
                    "unit_no": row.unit_no,
                    "unit_title": row.unit_title,
                    "word": row.word,
                    "status": "dup_in_db" if duplicate_in_db else "ok",
                    "entry_id": enriched.entry_id,
                    "phonetic_uk": enriched.phonetic_uk,
                    "phonetic_us": enriched.phonetic_us,
                    "senses": enriched.senses,
                    "examples": enriched.examples,
                    "phonics_split": enriched.phonics_split,
                    "used_lemma": enriched.used_lemma,
                    "ordinal": ordinals[row.unit_no],
                }
            )

        stats_counter = Counter(row["status"] for row in preview_rows)
        stats = {
            "total": len(rows),
            "ecdict_hit": stats_counter["ok"] + stats_counter["dup_in_db"],
            "missing": stats_counter["missing"],
            "dup_in_batch": stats_counter["dup_in_batch"],
            "dup_in_db": stats_counter["dup_in_db"],
        }

        batch.stats = stats
        batch.pending_queue = pending_queue
        batch.status = "enriched"

        payload = {
            "batch_id": batch.id,
            "source": source,
            "series": series,
            "grade": grade,
            "term": term,
            "stats": stats,
            "pending_queue": pending_queue,
            "rows": preview_rows,
            "generated_at": _now_iso(),
        }
        settings.imports_dir.mkdir(parents=True, exist_ok=True)
        _preview_path(settings, batch.id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        batch.status = "preview"
        session.commit()
        return payload
    except Exception:
        session.rollback()
        raise
    finally:
        enricher.close()


def commit_batch(
    session: Session,
    settings,
    batch_id: int,
    *,
    version: int | None = None,
) -> dict:
    """预览批次入库＋词包发布。同 identity+version 重发＝拒绝（S1 版本化不可变）。"""
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise PipelineError(f"批次不存在：{batch_id}")
    if batch.status != "preview":
        raise PipelineError(
            f"批次 {batch_id} 状态为「{batch.status}」，仅 preview 可提交"
            "（重复提交被拒：包版本化不可变，spec S1）"
        )
    preview_file = _preview_path(settings, batch_id)
    if not preview_file.exists():
        raise PipelineError(f"预览快照缺失：{preview_file}")
    preview = json.loads(preview_file.read_text(encoding="utf-8"))

    source: str = preview["source"]
    series: str = preview["series"]
    grade: str = preview["grade"]
    term: str = preview["term"]
    pack_rows = [row for row in preview["rows"] if row["status"] in PACKABLE_STATUS]
    if not pack_rows:
        raise PipelineError("无可入库词条（全部为查无/重复），拒绝建空包")

    max_version = (
        session.execute(
            select(func.max(WordPack.version)).where(
                WordPack.textbook_series == series,
                WordPack.grade == grade,
                WordPack.term == term,
            )
        ).scalar()
        or 0
    )
    version = version if version is not None else max_version + 1
    if version < 1:
        raise PipelineError(f"版本号须 >=1，收到：{version}")
    if version <= max_version:
        existing = session.execute(
            select(WordPack.id).where(
                WordPack.textbook_series == series,
                WordPack.grade == grade,
                WordPack.term == term,
                WordPack.version == version,
            )
        ).scalar_one_or_none()
        raise PackImmutabilityError(
            f"词包 {series}/{grade}{term} v{version} 已存在（id={existing}）。"
            "同版本重发被拒：版本化不可变（spec S1），修词请发新版本。"
        )

    target = bundle_dir(
        settings, source=source, series=series, grade=grade, term=term, version=version
    )
    if target.exists():
        raise PackImmutabilityError(f"包目录已存在，拒绝覆盖：{target}（版本化不可变，spec S1）")

    try:
        # 1) 入库：lexical_entries 稳定 id 复用（get-or-create）＋ word_versions 新内容行
        difficulty_band = f"{grade}{term}"
        new_entries, reused_entries = 0, 0
        packed_words: list[dict] = []
        for row in pack_rows:
            entry = session.get(LexicalEntry, row["entry_id"])
            if entry is None:
                entry = LexicalEntry(
                    id=row["entry_id"], headword=row["word"], difficulty_band=difficulty_band
                )
                session.add(entry)
                session.flush()
                new_entries += 1
            else:
                reused_entries += 1
            word_version = WordVersion(
                lexical_entry_id=entry.id,
                phonetic_uk=row.get("phonetic_uk"),
                phonetic_us=row.get("phonetic_us"),
                senses=row.get("senses"),
                examples=row.get("examples"),
                phonics_split=row.get("phonics_split"),
                source_batch_id=batch.id,
            )
            session.add(word_version)
            session.flush()
            packed_words.append(
                {
                    "unit_no": row["unit_no"],
                    "unit_title": row.get("unit_title"),
                    "lexical_entry_id": entry.id,
                    "headword": entry.headword,
                    "ordinal": row["ordinal"],
                    "phonetic_uk": word_version.phonetic_uk,
                    "phonetic_us": word_version.phonetic_us,
                    "senses": word_version.senses,
                    "examples": word_version.examples,
                    "phonics_split": word_version.phonics_split,
                    "used_lemma": row.get("used_lemma"),
                    "word_version_id": word_version.id,
                }
            )

        # 2) 包行＋单元行＋包-词关联（四级组织：教材版本/年级/学期/单元）
        pack = WordPack(
            version=version, source=source, textbook_series=series, grade=grade, term=term
        )
        session.add(pack)
        session.flush()
        unit_ids: dict[int, int] = {}
        for unit_no in sorted({word["unit_no"] for word in packed_words}):
            title = next(
                (
                    word["unit_title"]
                    for word in packed_words
                    if word["unit_no"] == unit_no and word.get("unit_title")
                ),
                None,
            )
            unit = WordPackUnit(pack_id=pack.id, unit_no=unit_no, title=title)
            session.add(unit)
            session.flush()
            unit_ids[unit_no] = unit.id
        for word in packed_words:
            session.add(
                WordPackEntry(
                    pack_id=pack.id,
                    unit_id=unit_ids[word["unit_no"]],
                    word_version_id=word["word_version_id"],
                    ordinal=word["ordinal"],
                )
            )

        # 3) bundle 写盘（units/unit-XX.json＋manifest 逐文件 SHA-256）→ 批次收口
        pack_identity = {
            "pack_id": pack.id,
            "source": source,
            "textbook_series": series,
            "grade": grade,
            "term": term,
            "version": version,
        }
        units_payload = _bundle_units(packed_words)
        write_bundle(target, pack_identity=pack_identity, units=units_payload, generated_at=_now_iso())
    except Exception:
        session.rollback()
        shutil.rmtree(target, ignore_errors=True)  # 半成品不留盘（防占住版本号）
        raise

    try:
        batch.status = "committed"
        batch.product_pack_id = pack.id
        session.commit()
    except Exception:
        session.rollback()
        shutil.rmtree(target, ignore_errors=True)
        raise

    verify_bundle(target)  # 发布即自校验（VALIDATE 4：manifest 逐文件 SHA-256 比对）
    return {
        "batch_id": batch_id,
        "pack_id": pack.id,
        "source": source,
        "textbook_series": series,
        "grade": grade,
        "term": term,
        "version": version,
        "bundle_dir": str(target),
        "manifest_files": len(units_payload),
        "committed_words": len(packed_words),
        "entries_new": new_entries,
        "entries_reused": reused_entries,
    }


def _bundle_units(packed_words: list[dict]) -> list[dict]:
    """按单元聚合 bundle 词载荷（units/unit-XX.json 内容），单元内按 ordinal 排序。"""
    words_by_unit: dict[int, list[dict]] = {}
    titles: dict[int, str | None] = {}
    for word in packed_words:
        words_by_unit.setdefault(word["unit_no"], []).append(
            {
                "lexical_entry_id": word["lexical_entry_id"],
                "headword": word["headword"],
                "ordinal": word["ordinal"],
                "phonetic_uk": word["phonetic_uk"],
                "phonetic_us": word["phonetic_us"],
                "senses": word["senses"],
                "examples": word["examples"],
                "phonics_split": word["phonics_split"],
                "used_lemma": word["used_lemma"],
            }
        )
        if word["unit_no"] not in titles or titles[word["unit_no"]] is None:
            titles[word["unit_no"]] = word.get("unit_title")
    units = []
    for unit_no in sorted(words_by_unit):
        units.append(
            {
                "unit_no": unit_no,
                "title": titles.get(unit_no),
                "words": sorted(words_by_unit[unit_no], key=lambda item: item["ordinal"]),
            }
        )
    return units
