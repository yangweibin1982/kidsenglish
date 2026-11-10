"""接缝：API 契约（spec S8）——业务路由全部挂令牌、返回 501 桩（逻辑归后续票）。

POST /api/sync 已由票 13 实现于 routers/sync.py（非桩）——其 401 门与契约
测试在 tests/test_sync_api.py。
"""
from __future__ import annotations

import pytest

S8_STUB_ROUTES = [
    ("get", "/api/packs"),
    ("get", "/api/packs/1/bundle"),
    ("get", "/api/children"),
    ("post", "/api/children"),
    ("put", "/api/children/1/settings"),
    ("get", "/api/children/1/reports/weekly"),
    ("get", "/api/templates/import-xlsx"),
    ("post", "/api/imports"),
    ("get", "/api/imports/1"),
    ("get", "/api/imports/1/preview"),
    ("post", "/api/imports/1/commit"),
]


@pytest.mark.parametrize(("method", "path"), S8_STUB_ROUTES)
def test_stub_route_gated_by_token_then_501(client, method: str, path: str) -> None:
    gate = getattr(client, method)(path)
    assert gate.status_code == 401, f"{method.upper()} {path} 未挂令牌依赖"

    token = client.app.state.family_token
    stub = getattr(client, method)(path, headers={"X-Family-Token": token})
    assert stub.status_code == 501, f"{method.upper()} {path} 应为未实现桩"
