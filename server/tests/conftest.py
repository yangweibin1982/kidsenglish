"""测试夹具：以 tmp 数据目录构建应用实例（隔离真实库与令牌）。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture()
def client(settings: Settings) -> TestClient:
    application = create_app(settings)
    with TestClient(application) as test_client:
        yield test_client
