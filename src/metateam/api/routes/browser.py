"""Browser sandbox (Playwright)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ...services.browser_sandbox import SANDBOX
from ..schemas import BrowserNavigateBody, BrowserPickBody, BrowserStartBody

router = APIRouter(prefix="/api/browser", tags=["browser"])


@router.get("/status")
def api_browser_status() -> dict[str, Any]:
    return SANDBOX.status()


@router.post("/session")
def api_browser_session(body: BrowserStartBody) -> dict[str, Any]:
    try:
        return SANDBOX.ensure_session(url=body.url, headless=bool(body.headless))
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/session")
def api_browser_session_close() -> dict[str, str]:
    SANDBOX.close()
    return {"status": "ok"}


@router.post("/navigate")
def api_browser_navigate(body: BrowserNavigateBody) -> dict[str, Any]:
    try:
        return SANDBOX.navigate(body.url)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/screenshot")
def api_browser_screenshot(full_page: bool = False):
    try:
        png = SANDBOX.screenshot_png(full_page=bool(full_page))
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(content=png, media_type="image/png")


@router.get("/console")
def api_browser_console(limit: int = 80) -> dict[str, Any]:
    logs = SANDBOX.console_logs(limit=limit)
    return {"count": len(logs), "logs": logs}


@router.post("/select")
def api_browser_select(body: BrowserPickBody) -> dict[str, Any]:
    try:
        payload = SANDBOX.pick_element(
            timeout_ms=int(body.timeout_ms),
            with_screenshot=bool(body.with_screenshot),
        )
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    if payload is None:
        return {"ok": False, "element": None, "message": "cancelled or timed out"}
    return {"ok": True, "element": payload.model_dump()}


@router.post("/select/cancel")
def api_browser_select_cancel() -> dict[str, str]:
    SANDBOX.cancel_pick()
    return {"status": "ok"}
