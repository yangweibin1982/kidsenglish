"""家庭令牌（spec S4）：装机首启生成、落盘持久化、依赖注入校验。

威胁模型＝家庭局域网/Tailscale 内网（R15 不暴露公网），不做账号体系。
"""
from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import HTTPException, Request

TOKEN_HEADER = "X-Family-Token"


def family_id_from_token(token: str) -> str:
    """家庭身份 id＝sha256(令牌) 前 16 位（hex）。

    用途：children.family_id 归属校验（票 13 sync 403 面）。存摘要不存令牌本体，
    令牌文件本身已明文落盘（G4 #4 已知），摘要面不再增加令牌副本。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def resolve_family(request: Request) -> str:
    """当前部署的家庭身份（由已过鉴权的应用态令牌派生）。"""
    token = getattr(request.app.state, "family_token", "")
    return family_id_from_token(token)


def ensure_family_token(settings) -> str:
    """首启生成并写入令牌文件；已有则原样复用（重启不换）。

    写盘走 os.open 独占创建（O_CREAT|O_EXCL）：并发/重复首启绝不覆盖既有令牌
    （G4 #4 配套——令牌是家庭唯一凭据，覆盖即锁死全部已装机设备）。
    0o600 在 POSIX 生效；Windows 下 mode 仅影响只读位（NTFS ACL 不归它管），
    真实权限收紧由部署脚本 icacls 承担（见 server/scripts/deploy.ps1）。
    """
    if settings.token_file.exists():
        existing = settings.token_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing

    token = secrets.token_urlsafe(32)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(
            settings.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
    except FileExistsError:
        # 文件在检查后被并发创建/为空残留：读回复用，非空绝不重写。
        existing = settings.token_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing
        settings.token_file.unlink()  # 空文件残留 → 移除后独占重建
        return ensure_family_token(settings)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token)
    return token


async def require_family_token(request: Request) -> None:
    expected = getattr(request.app.state, "family_token", None)
    supplied = request.headers.get(TOKEN_HEADER, "")

    if not expected or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="family token required")
