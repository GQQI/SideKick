from __future__ import annotations

from metateam.api.app import app


def test_app_registers_core_routes() -> None:
    paths = {getattr(r, "path", "") for r in app.routes}
    for needed in (
        "/api/sessions",
        "/api/chat",
        "/api/git",
        "/api/git/pull",
        "/api/git/push",
        "/api/git/fetch",
        "/api/git/checkout",
        "/api/git/remote",
        "/api/git/file-diff",
        "/api/git/review",
        "/api/files/undo",
        "/api/sessions/{session_id}/events",
    ):
        assert needed in paths, f"missing route {needed}"
