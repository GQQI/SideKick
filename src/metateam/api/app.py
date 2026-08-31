"""FastAPI application — middleware, routers, static UI, process entry."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..core.config import REPO_ROOT, get_settings
from ..services.local_auth import TOKEN_HEADER, is_loopback_bind, load_or_create_token
from .middleware import LocalAuthMiddleware
from .routes import register_routes

app = FastAPI(title="Sidekick", version="0.3.1")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", TOKEN_HEADER, "Content-Type", "Accept"],
)


def _is_public_path(method: str, path: str) -> bool:
    p = (path or "/").split("?", 1)[0].rstrip("/") or "/"
    if method == "OPTIONS" or p == "/":
        return True
    if p.startswith("/assets") or p.startswith("/favicon"):
        return True
    if p in {
        "/api/health",
        "/api/bootstrap",
        "/api/auth/status",
        "/api/auth/setup",
        "/api/auth/login",
        "/api/auth/register",
        "/api/auth/logout",
    }:
        return True
    return False


app.add_middleware(LocalAuthMiddleware, is_public=_is_public_path)

register_routes(app)

_ui_override = os.getenv("SIDEKICK_UI_DIST", "").strip().strip('"')
_WEB_DIST = Path(_ui_override).expanduser().resolve() if _ui_override else REPO_ROOT / "ui" / "dist"
if _WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=_WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(
            _WEB_DIST / "index.html",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    @app.get("/{full_path:path}")
    def spa(full_path: str) -> FileResponse:
        candidate = _WEB_DIST / full_path
        if candidate.is_file():
            headers = {}
            if candidate.suffix.lower() in {".html", ""}:
                headers = {
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                }
            return FileResponse(candidate, headers=headers)
        return FileResponse(
            _WEB_DIST / "index.html",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )


def main() -> None:
    import uvicorn

    s = get_settings()
    allow_remote = os.getenv("META_ALLOW_REMOTE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if not is_loopback_bind(s.host) and not allow_remote:
        raise SystemExit(
            f"Refusing to bind META_HOST={s.host!r} (not loopback). "
            "Use 127.0.0.1 or set META_ALLOW_REMOTE=1 (unsafe)."
        )
    load_or_create_token()
    print(f"Sidekick → http://{s.host}:{s.port}  demo={s.demo_mode} model={s.model}")
    print("Local token ready (header X-Sidekick-Token).")
    if not s.allow_shell:
        print("Shell tools disabled (META_ALLOW_SHELL=0). Set META_ALLOW_SHELL=1 to enable.")
    uvicorn.run(
        "metateam.api.app:app",
        host=s.host,
        port=s.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
