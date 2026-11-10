"""接缝：家庭令牌（spec S4）——首启生成、持久化、依赖校验、healthz 豁免。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_first_startup_generates_and_persists_token(settings: Settings) -> None:
    application = create_app(settings)

    with TestClient(application):
        token = application.state.family_token

    assert token
    assert settings.token_file.read_text(encoding="utf-8") == token


def test_restart_reuses_same_token(settings: Settings) -> None:
    tokens: list[str] = []
    for _ in range(2):
        application = create_app(settings)
        with TestClient(application):
            tokens.append(application.state.family_token)

    assert tokens[0] == tokens[1]


def test_distinct_installations_get_distinct_tokens(tmp_path) -> None:
    tokens: list[str] = []
    for i in range(2):
        settings = Settings(data_dir=tmp_path / f"install-{i}")
        application = create_app(settings)
        with TestClient(application):
            tokens.append(application.state.family_token)

    assert tokens[0] != tokens[1]


def test_api_route_without_token_returns_401(client) -> None:
    assert client.get("/api/packs").status_code == 401


def test_api_route_with_wrong_token_returns_401(client) -> None:
    response = client.get("/api/packs", headers={"X-Family-Token": "wrong-token"})

    assert response.status_code == 401


def test_valid_token_reaches_stub_not_401(client) -> None:
    token = client.app.state.family_token

    response = client.get("/api/packs", headers={"X-Family-Token": token})

    assert response.status_code == 501


def test_healthz_exempt_from_token(client) -> None:
    assert client.get("/healthz").status_code == 200
