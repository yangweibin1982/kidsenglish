"""全链编排（VALIDATE 1 对应）：预览统计/查无标黄/重复检测/入库/发版/同版本重发被拒。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.models import ImportBatch, LexicalEntry, WordPack, WordPackEntry, WordPackUnit, WordVersion
from app.pipeline.errors import PackImmutabilityError, PipelineError
from app.pipeline.runner import commit_batch, import_xlsx

SERIES = "沪教牛津（深圳专版）"


def _write_xlsx(path: Path, rows: list[tuple[str, str, str]]) -> Path:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["年级", "单元", "单词"])
    for row in rows:
        sheet.append(list(row))
    workbook.save(path)
    return path


def test_preview_stats_pending_queue_and_snapshot(pipe_session, pipe_settings, ecdict_db, sample_xlsx) -> None:
    payload = import_xlsx(
        pipe_session, pipe_settings, sample_xlsx, source="official", series=SERIES
    )
    assert payload["stats"] == {
        "total": 7, "ecdict_hit": 3, "missing": 2, "dup_in_batch": 2, "dup_in_db": 0,
    }
    # 批内重复：hello 与 " HELLO " 都归一到 row2 首现
    dups = [row for row in payload["rows"] if row["status"] == "dup_in_batch"]
    assert [(row["row_no"], row["duplicate_of_row"]) for row in dups] == [(7, 2), (8, 2)]
    # 查无标黄 → 待补队列 E7（顺序按行号；两类 miss 理由齐）
    assert [(item["word"], item["reason"]) for item in payload["pending_queue"]] == [
        ("zorblat", "ecdict_miss"),
        ("onlydomain", "domain_only"),
    ]
    # 预览快照落盘（commit 以快照为准）＋批次状态机
    snapshot = pipe_settings.imports_dir / f"batch_{payload['batch_id']}_preview.json"
    assert snapshot.exists()
    assert json.loads(snapshot.read_text(encoding="utf-8"))["stats"] == payload["stats"]
    batch = pipe_session.get(ImportBatch, payload["batch_id"])
    assert batch.status == "preview" and batch.stats["total"] == 7


def test_commit_pack_v1_and_recommit_rejected(pipe_session, pipe_settings, ecdict_db, sample_xlsx) -> None:
    payload = import_xlsx(pipe_session, pipe_settings, sample_xlsx, source="official", series=SERIES)
    result = commit_batch(pipe_session, pipe_settings, payload["batch_id"])

    assert result["version"] == 1
    assert result["committed_words"] == 3  # 入库行数与预览一致（3 个可入包词）
    assert result["entries_new"] == 3 and result["entries_reused"] == 0

    # lexical_entries 稳定 id + 难度带
    entry_ids = set(pipe_session.execute(select(LexicalEntry.id)).scalars())
    assert entry_ids == {"w_hello", "w_school", "w_licked"}
    assert all(
        entry.difficulty_band == "1上"
        for entry in pipe_session.execute(select(LexicalEntry)).scalars()
    )

    # word_versions：3 行内容行，挂 source_batch_id；包-词关联锚定 word_versions
    versions = pipe_session.execute(select(WordVersion)).scalars().all()
    assert len(versions) == 3
    assert all(version.source_batch_id == payload["batch_id"] for version in versions)
    assert pipe_session.execute(select(func.count()).select_from(WordPackEntry)).scalar() == 3

    # 四级组织：official/系列/1上/v1；单元行标题来自 xlsx
    pack = pipe_session.execute(select(WordPack)).scalar_one()
    assert (pack.source, pack.textbook_series, pack.grade, pack.term, pack.version) == (
        "official", SERIES, "1", "上", 1,
    )
    unit = pipe_session.execute(select(WordPackUnit)).scalar_one()
    assert (unit.unit_no, unit.title) == (1, "Hello")

    # bundle：manifest＋逐文件；屈折词 licked 在 bundle 里带 used_lemma 留痕
    bundle = Path(result["bundle_dir"])
    unit_payload = json.loads((bundle / "units" / "unit-01.json").read_text(encoding="utf-8"))
    by_word = {word["headword"]: word for word in unit_payload["words"]}
    assert by_word["licked"]["used_lemma"] == "lick"
    assert by_word["licked"]["phonetic_uk"] == "lɪk"  # lemma 基词音标，非编造
    assert [word["ordinal"] for word in unit_payload["words"]] == [1, 2, 3]

    # 同批次重发＝拒绝（状态机：preview 才可提交）
    with pytest.raises(PipelineError, match="重复提交被拒"):
        commit_batch(pipe_session, pipe_settings, payload["batch_id"])


def test_republish_new_version_and_v1_untouched(pipe_session, pipe_settings, ecdict_db, sample_xlsx, tmp_path) -> None:
    first = import_xlsx(pipe_session, pipe_settings, sample_xlsx, source="official", series=SERIES)
    v1 = commit_batch(pipe_session, pipe_settings, first["batch_id"])
    v1_manifest = (Path(v1["bundle_dir"]) / "manifest.json").read_bytes()

    # 二次导入同样 3 词：库内已有 → dup_in_db=3（复用稳定 id，不新建词条）
    xlsx2 = _write_xlsx(tmp_path / "second.xlsx", [
        ("1上", "1 Hello", "hello"), ("1上", "1 Hello", "school"), ("1上", "1 Hello", "licked"),
    ])
    payload2 = import_xlsx(pipe_session, pipe_settings, xlsx2, source="official", series=SERIES)
    assert payload2["stats"]["dup_in_db"] == 3 and payload2["stats"]["ecdict_hit"] == 3
    v2 = commit_batch(pipe_session, pipe_settings, payload2["batch_id"])
    assert v2["version"] == 2  # 自动取下一版本
    assert v2["entries_new"] == 0 and v2["entries_reused"] == 3
    assert pipe_session.execute(select(func.count()).select_from(LexicalEntry)).scalar() == 3
    assert pipe_session.execute(select(func.count()).select_from(WordVersion)).scalar() == 6

    # v1 bundle 不可变：manifest 字节未动，校验仍通过
    assert (Path(v1["bundle_dir"]) / "manifest.json").read_bytes() == v1_manifest
    from app.pipeline.pack import verify_bundle

    assert verify_bundle(Path(v1["bundle_dir"]))["files"] == 1


def test_explicit_stale_version_rejected(pipe_session, pipe_settings, ecdict_db, sample_xlsx, tmp_path) -> None:
    first = import_xlsx(pipe_session, pipe_settings, sample_xlsx, source="official", series=SERIES)
    commit_batch(pipe_session, pipe_settings, first["batch_id"])

    xlsx3 = _write_xlsx(tmp_path / "third.xlsx", [("1上", "1 Hello", "morning")])
    payload3 = import_xlsx(pipe_session, pipe_settings, xlsx3, source="official", series=SERIES)
    # 显式重发 v1（已存在）＝拒绝；随后自动版本发 v2 成功
    with pytest.raises(PackImmutabilityError, match="同版本重发被拒"):
        commit_batch(pipe_session, pipe_settings, payload3["batch_id"], version=1)
    v2 = commit_batch(pipe_session, pipe_settings, payload3["batch_id"])
    assert v2["version"] == 2


def test_single_grade_term_per_batch_enforced(pipe_session, pipe_settings, ecdict_db, tmp_path) -> None:
    mixed = _write_xlsx(tmp_path / "mixed.xlsx", [
        ("1上", "1 Hello", "hello"), ("1下", "1 Hello", "school"),
    ])
    with pytest.raises(PipelineError, match="一个批次仅支持一个"):
        import_xlsx(pipe_session, pipe_settings, mixed, source="official", series=SERIES)


def test_missing_xlsx_and_unknown_batch(pipe_session, pipe_settings, ecdict_db, tmp_path) -> None:
    with pytest.raises(PipelineError, match="不存在"):
        import_xlsx(pipe_session, pipe_settings, tmp_path / "nope.xlsx", source="official", series=SERIES)
    with pytest.raises(PipelineError, match="批次不存在"):
        commit_batch(pipe_session, pipe_settings, 999)


def test_all_missing_rejects_empty_pack(pipe_session, pipe_settings, ecdict_db, tmp_path) -> None:
    only_miss = _write_xlsx(tmp_path / "miss.xlsx", [("1上", "1 Hello", "zorblat")])
    payload = import_xlsx(pipe_session, pipe_settings, only_miss, source="official", series=SERIES)
    assert payload["stats"]["missing"] == 1
    with pytest.raises(PipelineError, match="拒绝建空包"):
        commit_batch(pipe_session, pipe_settings, payload["batch_id"])
