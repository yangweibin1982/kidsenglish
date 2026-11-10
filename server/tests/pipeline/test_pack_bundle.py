"""词包 bundle：manifest 逐文件 SHA-256、篡改检测、目录不可变（S1）。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.pipeline.errors import PackImmutabilityError, PipelineError
from app.pipeline.pack import slugify, verify_bundle, write_bundle

IDENTITY = {
    "pack_id": 1,
    "source": "official",
    "textbook_series": "沪教牛津（深圳专版）",
    "grade": "1",
    "term": "上",
    "version": 1,
}
UNITS = [
    {"unit_no": 1, "title": "Hello", "words": [{"lexical_entry_id": "w_hello", "headword": "hello", "ordinal": 1}]},
    {"unit_no": 2, "title": None, "words": []},
]


def test_write_and_verify_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "v1"
    files = write_bundle(target, pack_identity=IDENTITY, units=UNITS, generated_at="2026-10-24T00:00:00+00:00")

    assert [entry["path"] for entry in files] == ["units/unit-01.json", "units/unit-02.json"]
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["pack"] == IDENTITY
    assert len(manifest["files"]) == 2
    # manifest 逐文件 SHA-256 与实际字节一致（VALIDATE 4 断言项）
    for entry in manifest["files"]:
        data = (target / entry["path"]).read_bytes()
        assert entry["sha256"] == hashlib.sha256(data).hexdigest()
        assert entry["bytes"] == len(data)

    result = verify_bundle(target)
    assert result["files"] == 2


def test_verify_detects_tamper(tmp_path: Path) -> None:
    target = tmp_path / "v1"
    write_bundle(target, pack_identity=IDENTITY, units=UNITS, generated_at="t")
    (target / "units" / "unit-01.json").write_bytes(b'{"tampered": true}\n')
    with pytest.raises(PipelineError, match="SHA-256 不匹配"):
        verify_bundle(target)


def test_verify_detects_missing_file(tmp_path: Path) -> None:
    target = tmp_path / "v1"
    write_bundle(target, pack_identity=IDENTITY, units=UNITS, generated_at="t")
    (target / "units" / "unit-02.json").unlink()
    with pytest.raises(PipelineError, match="缺文件"):
        verify_bundle(target)


def test_bundle_dir_is_immutable(tmp_path: Path) -> None:
    target = tmp_path / "v1"
    write_bundle(target, pack_identity=IDENTITY, units=UNITS, generated_at="t")
    before = sorted(path.name for path in target.rglob("*"))
    with pytest.raises(PackImmutabilityError):
        write_bundle(target, pack_identity=IDENTITY, units=UNITS, generated_at="t")
    # 拒绝即无副作用：原 bundle 未被覆盖
    assert sorted(path.name for path in target.rglob("*")) == before


def test_slugify_keeps_cjk_and_sanitizes() -> None:
    assert slugify("沪教牛津（深圳专版）") == "沪教牛津（深圳专版）"
    assert slugify("a/b:c*?") == "a_b_c"
    assert slugify("  x  ") == "x"
