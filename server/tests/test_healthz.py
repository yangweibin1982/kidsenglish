"""接缝：API 契约（spec 接缝 5）——healthz 探活，免令牌。"""
from __future__ import annotations


def test_healthz_returns_ok_without_token(client) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
