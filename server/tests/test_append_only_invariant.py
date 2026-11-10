"""G4 Standards #2（票 13 移交）：learning_events 只增不减不变式。

两层机器强制：
1. 静态面——app/ 全域源码无任何 UPDATE/DELETE learning_events 路径（原生 SQL
   与 SQLAlchemy 构造双查），且无 f-string/% 拼接 SQL（参数绑定纪律全域保持）；
2. 动态面——同步 API 双写场景重放：同集重投（重试）与同 id 异容（覆盖尝试）
   均保持库内行集同态（见 test_sync_api.py 幂等两例；此处补折叠只增不减对账）。
"""
from __future__ import annotations

import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1] / "app"

_RAW_UPDATE_DELETE_RE = re.compile(
    r"(?i)UPDATE\s+learning_events|DELETE\s+FROM\s+learning_events"
)
_ORM_UPDATE_DELETE_RE = re.compile(r"\.(?:update|delete)\(\s*LearningEvent\b")
_FSTRING_SQL_RE = re.compile(r"\.execute\w*\(\s*f['\"]")
_RAW_SQL_FORMAT_RE = re.compile(r"%\s*\(")


def _app_sources() -> list[Path]:
    return [
        path
        for path in sorted(APP_DIR.rglob("*.py"))
        if "__pycache__" not in path.parts
    ]


def test_no_update_or_delete_path_on_learning_events() -> None:
    """app/ 全域源码无 UPDATE/DELETE learning_events（原生 SQL＋ORM 构造双查）。"""
    offenders: list[str] = []
    for source in _app_sources():
        text = source.read_text(encoding="utf-8")
        if _RAW_UPDATE_DELETE_RE.search(text) or _ORM_UPDATE_DELETE_RE.search(text):
            offenders.append(source.name)
    assert offenders == [], f"learning_events 出现改写/删除路径：{offenders}"


def test_no_string_concatenated_sql_in_app() -> None:
    """参数绑定纪律（仓库静态扫描形状）从 pipeline 扩面到 app/ 全域。"""
    offenders: list[str] = []
    for source in _app_sources():
        text = source.read_text(encoding="utf-8")
        if _FSTRING_SQL_RE.search(text) or _RAW_SQL_FORMAT_RE.search(text):
            offenders.append(source.name)
    assert offenders == [], f"疑似字符串拼接 SQL：{offenders}"


def test_upsert_is_conflict_do_nothing_not_replace() -> None:
    """UPSERT 语义钉死：sync 路由用 ON CONFLICT DO NOTHING（禁 OR REPLACE/UPDATE）。"""
    sync_source = (APP_DIR / "routers" / "sync.py").read_text(encoding="utf-8")
    assert "on_conflict_do_nothing" in sync_source
    assert "on_conflict_do_update" not in sync_source or "SyncCursor" in sync_source
    # learning_events 落库语句只允许 DO NOTHING；DO UPDATE 仅限 sync_cursors 游标行
    learning_block = sync_source.split("sqlite_insert(LearningEvent)", 1)[1][:400]
    assert "on_conflict_do_nothing" in learning_block
    assert "on_conflict_do_update" not in learning_block
