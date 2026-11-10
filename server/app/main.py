"""应用工厂：healthz 免鉴权；/api 全部挂家庭令牌依赖（spec S4/S8）。

CORS（G4 Standards #1，票 13）：origin 白名单钉死于 config.DEFAULT_CORS_ORIGINS
（Capacitor 原生 https://localhost＋dev server http://localhost:5173），禁 `*`。
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import TOKEN_HEADER, ensure_family_token
from app.config import Settings
from app.db import create_session_factory, create_single_writer_engine
from app.routers.stubs import router as api_router
from app.routers.sync import router as sync_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        application.state.family_token = ensure_family_token(settings)
        engine = create_single_writer_engine(settings)
        application.state.engine = engine
        application.state.SessionLocal = create_session_factory(engine)
        yield
        engine.dispose()

    application = FastAPI(title="KidsEnglish Server", version="0.1.0", lifespan=lifespan)
    application.state.settings = settings
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,  # 无 cookie 凭据；鉴权走令牌头
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=[TOKEN_HEADER, "Content-Type"],
    )

    # FastAPI 路由装饰器注册，标准模式。
    @application.get("/healthz")  # nosemgrep: python.lang.maintainability.useless-inner-function
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(api_router)
    application.include_router(sync_router)
    return application


app = create_app()
