"""ECDICT 预载：幂等重跑、强制重建、下载 URL https+host 白名单门。"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.pipeline.errors import PreloadError
from app.pipeline.preload import DOWNLOAD_URL, preload_from_csv, validate_download_url
from tests.pipeline.conftest import MINI_ECDICT_ROWS


def test_preload_imports_and_replaces_literal_newline(ecdict_csv: Path, tmp_path: Path) -> None:
    db_path = tmp_path / "data" / "ecdict" / "ecdict.db"
    result = preload_from_csv(ecdict_csv, db_path)
    assert result["skipped"] is False
    assert result["rows"] == len(MINI_ECDICT_ROWS)

    conn = sqlite3.connect(db_path)
    try:
        word, translation = conn.execute(
            "SELECT word, translation FROM ecdict WHERE word = ?", ("hello",)
        ).fetchone()
        assert word == "hello"
        assert "\n" in translation and "\\n" not in translation  # 字面量 \n 已替换
        # NOCASE 索引存在（06 §7）
        indexes = {
            row[1]
            for row in conn.execute("PRAGMA index_list(ecdict)").fetchall()
        }
        assert "idx_ecdict_word_nocase" in indexes
        # 幂等标记表
        marker = dict(conn.execute("SELECT key, value FROM preload_meta"))
        assert marker["csv_rows"] == str(len(MINI_ECDICT_ROWS))
        assert len(marker["csv_sha256"]) == 64
    finally:
        conn.close()


def test_preload_idempotent_rerun_skips(ecdict_csv: Path, tmp_path: Path) -> None:
    db_path = tmp_path / "ecdict.db"
    first = preload_from_csv(ecdict_csv, db_path)
    second = preload_from_csv(ecdict_csv, db_path)
    assert first["skipped"] is False and second["skipped"] is True
    assert second["rows"] == first["rows"]


def test_preload_force_rebuilds(ecdict_csv: Path, tmp_path: Path) -> None:
    db_path = tmp_path / "ecdict.db"
    preload_from_csv(ecdict_csv, db_path)
    forced = preload_from_csv(ecdict_csv, db_path, force=True)
    assert forced["skipped"] is False


def test_preload_missing_csv_raises(ecdict_csv: Path, tmp_path: Path) -> None:
    with pytest.raises(PreloadError, match="不存在"):
        preload_from_csv(tmp_path / "nope.csv", tmp_path / "out.db")


def test_download_url_https_only_and_host_allowlist() -> None:
    validate_download_url(DOWNLOAD_URL)  # 合法源直通
    with pytest.raises(PreloadError, match="https"):
        validate_download_url("http://codeload.github.com/skywind3000/ECDICT/tar.gz/refs/heads/master")
    with pytest.raises(PreloadError, match="白名单"):
        validate_download_url("https://evil.example.com/ECDICT.tar.gz")
