"""SQLite 单写拓扑（spec S3）：

- uvicorn 单进程＋StaticPool 单连接＝应用内天然串行队列，禁多 worker 共写。
- WAL：读写不互阻塞；busy_timeout 显式 ≥5000ms 兜底。
- PRAGMA 全部常量字面量（无字符串拼接）；本模块无任何业务 SQL。
"""
from __future__ import annotations

from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

BUSY_TIMEOUT_MS = 10_000  # spec 下限 5000ms，留 2 倍余量
# sqlite 的 PRAGMA 不接受绑定参数（SQLite 限制）→ 常量字面量，禁拼接；
# 两处同值维护，实际值由 tests/test_single_writer.py 读 PRAGMA 断言兜底。
_BUSY_TIMEOUT_PRAGMA = "PRAGMA busy_timeout=10000"


def create_single_writer_engine(settings) -> Engine:
    engine = create_engine(
        settings.database_url,
        poolclass=StaticPool,
        connect_args={
            "check_same_thread": False,
            "timeout": BUSY_TIMEOUT_MS / 1000,  # sqlite3 驱动层 busy 等待（秒）
        },
    )

    # SQLAlchemy event 装饰器注册回调，标准模式，非无用内嵌函数。
    @event.listens_for(engine, "connect")  # nosemgrep: python.lang.maintainability.useless-inner-function
    def _apply_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute(_BUSY_TIMEOUT_PRAGMA)
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


def get_db(request: Request) -> Iterator[Session]:
    """FastAPI 依赖：从应用态取单写引擎的会话。"""
    session_factory = request.app.state.SessionLocal
    session = session_factory()
    try:
        yield session
    finally:
        session.close()
