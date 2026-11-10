"""接缝：单写拓扑（spec S3）——配置级证据：StaticPool 单连接＋WAL＋busy_timeout≥5000。

禁多 worker 共写：引擎必须是单连接静态池；PRAGMA 常量字面量、无字符串拼接。
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.pool import StaticPool


def test_engine_pool_is_single_static_connection(client) -> None:
    engine = client.app.state.engine

    assert isinstance(engine.pool, StaticPool), "单写拓扑要求 StaticPool 单连接"


def test_connection_pragmas_wal_busy_timeout_foreign_keys(client) -> None:
    engine = client.app.state.engine

    with engine.connect() as conn:
        journal_mode = conn.execute(text("PRAGMA journal_mode")).scalar()
        busy_timeout_ms = conn.execute(text("PRAGMA busy_timeout")).scalar()
        foreign_keys = conn.execute(text("PRAGMA foreign_keys")).scalar()

    assert str(journal_mode).lower() == "wal"
    assert busy_timeout_ms >= 5000
    assert foreign_keys == 1


def test_sessions_bind_to_the_single_writer_engine(client) -> None:
    engine = client.app.state.engine

    with client.app.state.SessionLocal() as session:
        assert session.get_bind() is engine


def test_database_lands_in_configured_data_dir(client, settings) -> None:
    assert client.app.state.settings.db_path.parent == settings.data_dir
    assert client.app.state.settings.db_path.name == "kidsenglish.db"
