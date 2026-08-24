"""Shared HTTP helpers for API routers."""

from __future__ import annotations

from typing import Any, NoReturn

from fastapi import HTTPException, Request

from ..services.local_auth import peer_is_loopback
from ..services.store import STORE, ChatSession


def require_loopback(request: Request) -> None:
    host = request.client.host if request.client else None
    if not peer_is_loopback(host):
        raise HTTPException(403, "loopback only")


def require_session(session_id: str) -> ChatSession:
    sess = STORE.get(session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    return sess


def raise_fs_http(exc: BaseException) -> NoReturn:
    """Map filesystem / path errors to HTTP status codes."""
    if isinstance(exc, FileNotFoundError):
        raise HTTPException(404, str(exc)) from exc
    if isinstance(exc, FileExistsError):
        raise HTTPException(409, f"already exists: {exc}") from exc
    if isinstance(exc, ValueError):
        raise HTTPException(400, str(exc)) from exc
    if isinstance(exc, OSError):
        raise HTTPException(500, str(exc)) from exc
    raise HTTPException(500, str(exc)) from exc


def call_fs(fn, *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except (FileNotFoundError, FileExistsError, ValueError, OSError) as exc:
        raise_fs_http(exc)


def git_result_or_400(result: str) -> str:
    if str(result).startswith("ERROR"):
        raise HTTPException(400, result)
    return result
