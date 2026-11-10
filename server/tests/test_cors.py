"""G4 Standards #1（票 13 移交）：CORS origin 白名单——放行/拒绝实测。

白名单＝['https://localhost'（Capacitor 原生 origin）, 'http://localhost:5173'
（Vite dev server）]；禁 `*`、禁反射任意请求 origin。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import DEFAULT_CORS_ORIGINS


def test_settings_pinned_default_whitelist(settings) -> None:
    assert settings.cors_origins == ("https://localhost", "http://localhost:5173")
    assert "*" not in settings.cors_origins


def test_settings_whitelist_injectable(settings) -> None:
    """可配置面（构造注入覆盖）与默认钉死并存。"""
    from app.config import Settings

    custom = Settings(data_dir=settings.data_dir, cors_origins=["https://nas.lan"])
    assert custom.cors_origins == ("https://nas.lan",)


def test_preflight_allowed_for_native_origin(client: TestClient) -> None:
    response = client.options(
        "/api/sync",
        headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-family-token",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://localhost"
    assert "x-family-token" in response.headers["access-control-allow-headers"].lower()


def test_preflight_allowed_for_dev_server(client: TestClient) -> None:
    response = client.options(
        "/api/sync",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_preflight_rejected_for_unknown_origin(client: TestClient) -> None:
    response = client.options(
        "/api/sync",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 400  # Disallowed CORS request
    assert "access-control-allow-origin" not in response.headers


def test_simple_request_grants_only_whitelisted_origin(client: TestClient) -> None:
    ok = client.get("/healthz", headers={"Origin": "https://localhost"})
    assert ok.headers["access-control-allow-origin"] == "https://localhost"  # 精确回显白名单项

    denied = client.get("/healthz", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in denied.headers  # 未授予任何 CORS 头


def test_wildcard_never_granted(client: TestClient) -> None:
    """禁 `*`：白名单内 origin 得到的是精确 origin，非通配。"""
    for origin in DEFAULT_CORS_ORIGINS:
        response = client.get("/healthz", headers={"Origin": origin})
        assert response.headers["access-control-allow-origin"] == origin
        assert response.headers["access-control-allow-origin"] != "*"
