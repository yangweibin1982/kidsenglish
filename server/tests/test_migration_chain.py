"""迁移链一致性（票 13 VALIDATE 2 的机器面）：单 head、链完整、链产物＝模型。

对真实库的 `alembic upgrade head` 实跑留痕在交付报告（数据库迁移纪律）；
此处做只读断言（ScriptDirectory）＋空库全链重放与 Base.metadata.create_all
的 schema 对账（禁只对空库验证即视为完成——真实库实跑另行留痕）。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.models import Base

SERVER_ROOT = Path(__file__).resolve().parents[1]
FIRST_REVISION = "c33071e1a2ac"  # 02 票首迁移（核心 11 概念表）
HEAD_REVISION = "a41f8c2d5e07"  # 13 票：learning_events 信封化＋children.family_id


def _alembic_config(db_url: str) -> Config:
    config = Config(str(SERVER_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", db_url)  # env.py 以环境变量优先
    return config


def test_single_head_and_chain_integrity() -> None:
    script = ScriptDirectory(str(SERVER_ROOT / "migrations"))
    heads = script.get_heads()
    assert heads == [HEAD_REVISION], f"多 head 或漂移：{heads}"
    revisions = [rev.revision for rev in script.walk_revisions()]
    assert set(revisions) == {FIRST_REVISION, HEAD_REVISION}
    assert script.get_revision(HEAD_REVISION).down_revision == FIRST_REVISION


def test_upgrade_chain_replay_matches_models_schema(tmp_path, monkeypatch) -> None:
    """空库走迁移链建 schema ↔ Base.metadata.create_all 建 schema：列集一致。"""
    migrated_db = tmp_path / "migrated.db"
    model_db = tmp_path / "models.db"

    monkeypatch.setenv("KIDS_ENGLISH_DB_URL", f"sqlite:///{migrated_db.as_posix()}")
    command.upgrade(_alembic_config(f"sqlite:///{migrated_db.as_posix()}"), "head")

    from sqlalchemy import create_engine

    engine = create_engine(f"sqlite:///{model_db.as_posix()}")
    Base.metadata.create_all(engine)
    engine.dispose()

    def columns_of(db_path: Path) -> dict[str, list[tuple[str, str, int]]]:
        conn = sqlite3.connect(db_path)
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
                if not row[0].startswith(("sqlite_", "alembic"))
            }
            result = {}
            for table in sorted(tables):
                result[table] = sorted(
                    # pragma_table_info 表值函数可参数绑定（表名来自自家库枚举）。
                    (row[1], row[2].upper(), int(row[3] or 0))
                    for row in conn.execute(
                        "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)",
                        (table,),
                    )
                )
            return result
        finally:
            conn.close()

    assert columns_of(migrated_db) == columns_of(model_db)


@pytest.mark.parametrize(
    ("table", "column", "notnull"),
    [
        ("learning_events", "type", 1),  # NOT NULL
        ("learning_events", "payload", 0),
        ("learning_events", "lexical_entry_id", 0),  # 信封化放宽容
        ("children", "family_id", 0),
    ],
)
def test_envelope_columns_present_with_expected_nullability(
    tmp_path, monkeypatch, table: str, column: str, notnull: int
) -> None:
    """信封化列存在且可空性符合设计（type NOT NULL，其余可空）。"""
    migrated_db = tmp_path / "check.db"
    monkeypatch.setenv("KIDS_ENGLISH_DB_URL", f"sqlite:///{migrated_db.as_posix()}")
    command.upgrade(_alembic_config(f"sqlite:///{migrated_db.as_posix()}"), "head")

    conn = sqlite3.connect(migrated_db)
    try:
        # pragma_table_info 表值函数参数绑定（table 为测试内字面量）。
        info = {
            row[1]: row[3]
            for row in conn.execute(
                "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)",
                (table,),
            )
        }
    finally:
        conn.close()
    assert column in info, f"{table}.{column} 缺失"
    assert info[column] == notnull, f"{table}.{column} notnull={info[column]}，预期 {notnull}"
