"""Local-only auth + tenant bind for API requests."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from ..core.config import get_settings, reset_request_settings
from ..core.logutil import get_logger, log_exception
from ..services.local_auth import TOKEN_HEADER, peer_is_loopback
from ..services.store import STORE
from ..services.tenant_context import reset_user, set_user
from ..services.user_auth import resolve_token

_log = get_logger("metateam.api.auth")

DEFAULT_PUBLIC_PREFIXES = (
    "/api/health",
    "/api/bootstrap",
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/assets/",
    "/favicon",
)


def default_is_public(method: str, path: str) -> bool:
    if method == "OPTIONS" or path == "/":
        return True
    return any(path.startswith(p) for p in DEFAULT_PUBLIC_PREFIXES)


def bind_tenant_workspace(user_id: str) -> None:
    """Bind this user's overlay (workspace / skills / memory) onto live sessions."""
    get_settings()
    try:
        STORE.refresh_settings(
            rebind_llm=False,
            rebind_workspace=True,
            user_id=user_id,
        )
    except Exception as exc:
        log_exception(_log, "refresh_settings after workspace bind failed", exc)


class LocalAuthMiddleware(BaseHTTPMiddleware):
    """Require X-Sidekick-Token on API routes; reject non-loopback peers."""

    def __init__(
        self,
        app,
        *,
        is_public: Callable[[str, str], bool] | None = None,
    ) -> None:
        super().__init__(app)
        self._is_public = is_public or default_is_public

    async def dispatch(self, request: Request, call_next):
        path = request.url.path or "/"
        client_host = request.client.host if request.client else None
        reset_user()

        if request.method == "OPTIONS":
            return await call_next(request)

        if path.startswith("/api/") and not peer_is_loopback(client_host):
            return JSONResponse({"detail": "only loopback clients allowed"}, status_code=403)

        public = self._is_public(request.method, path)
        if path.startswith("/api/") and not public:
            token = request.headers.get(TOKEN_HEADER) or request.headers.get("X-Sidekick-Token")
            if not token:
                token = request.query_params.get("token")
            resolved = resolve_token(token)
            if not resolved:
                return JSONResponse({"detail": "missing or invalid local token"}, status_code=401)
            uid, uname = resolved
            set_user(uid, uname)
            request.state.user_id = uid
            request.state.username = uname
            bind_tenant_workspace(uid)
        elif path.startswith("/api/") and public:
            token = request.headers.get(TOKEN_HEADER) or request.headers.get("X-Sidekick-Token")
            resolved = resolve_token(token) if token else None
            if resolved:
                uid, uname = resolved
                set_user(uid, uname)
                request.state.user_id = uid
                request.state.username = uname
                bind_tenant_workspace(uid)

        try:
            return await call_next(request)
        finally:
            reset_request_settings()
            reset_user()
