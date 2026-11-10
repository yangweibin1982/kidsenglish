"""业务路由桩（spec S8 面）：只挂令牌依赖、返回 501——逻辑归后续票。

- packs：词包分发（后续票）
- sync：双向事件交换——已由 routers/sync.py 实现（票 13，非桩）
- children/reports：家长域（后续票）
- imports/templates：导入管线（后续票）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.auth import require_family_token

router = APIRouter(prefix="/api", dependencies=[Depends(require_family_token)])


def _stub(domain: str) -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={"detail": f"not implemented: {domain} (后续票填充)"},
    )


@router.get("/packs")
def list_packs() -> JSONResponse:
    return _stub("packs.list")


@router.get("/packs/{pack_id}/bundle")
def get_pack_bundle(pack_id: int) -> JSONResponse:
    return _stub("packs.bundle")


@router.get("/children")
def list_children() -> JSONResponse:
    return _stub("children.list")


@router.post("/children")
def create_child() -> JSONResponse:
    return _stub("children.create")


@router.put("/children/{child_id}/settings")
def update_child_settings(child_id: int) -> JSONResponse:
    return _stub("children.settings")


@router.get("/children/{child_id}/reports/weekly")
def weekly_report(child_id: int) -> JSONResponse:
    return _stub("children.reports_weekly")


@router.get("/templates/import-xlsx")
def import_template() -> JSONResponse:
    return _stub("imports.template")


@router.post("/imports")
def create_import() -> JSONResponse:
    return _stub("imports.create")


@router.get("/imports/{batch_id}")
def get_import(batch_id: int) -> JSONResponse:
    return _stub("imports.get")


@router.get("/imports/{batch_id}/preview")
def import_preview(batch_id: int) -> JSONResponse:
    return _stub("imports.preview")


@router.post("/imports/{batch_id}/commit")
def import_commit(batch_id: int) -> JSONResponse:
    return _stub("imports.commit")
