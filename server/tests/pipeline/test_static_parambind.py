"""安全静态断言：pipeline 全模块无 f-string 拼 SQL；下载 URL 门存在。"""
from __future__ import annotations

import re
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[2] / "app" / "pipeline"

_FSTRING_SQL_RE = re.compile(r"\.execute\w*\(\s*f['\"]")
_RAW_SQL_FORMAT_RE = re.compile(r"%\s*\(")


def test_no_fstring_sql_in_pipeline() -> None:
    offenders = []
    for py_file in sorted(PIPELINE_DIR.glob("*.py")):
        source = py_file.read_text(encoding="utf-8")
        if _FSTRING_SQL_RE.search(source) or _RAW_SQL_FORMAT_RE.search(source):
            offenders.append(py_file.name)
    assert offenders == [], f"疑似字符串拼接 SQL：{offenders}"


def test_ecdict_lookup_uses_bound_parameters() -> None:
    source = (PIPELINE_DIR / "ecdict.py").read_text(encoding="utf-8")
    assert "WHERE word = ? COLLATE NOCASE" in source  # 占位符点查
    assert "(word,)" in source.replace(" ", "") or "(word, )".replace(" ", "") in source.replace(" ", "")


def test_preload_download_guard_present() -> None:
    source = (PIPELINE_DIR / "preload.py").read_text(encoding="utf-8")
    assert 'parts.scheme != "https"' in source  # 仅 https
    assert "ALLOWED_DOWNLOAD_HOSTS" in source  # host 白名单
    assert "DOWNLOAD_DEADLINE_S" in source  # 止损
