"""CDP browser sandbox tools (navigate / screenshot / click / type)."""

from __future__ import annotations

import json

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext

_DOCUMENT_EXTS = {
    ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".odt", ".odp", ".ods",
    ".epub", ".rtf", ".pdf", ".txt", ".md", ".markdown", ".csv", ".json",
    ".yaml", ".yml", ".xml", ".log",
}


def _local_document_hint(target: str) -> str:
    """Steer the model to read_file when it hands a document name to the browser."""
    low = target.lower().strip().rstrip("/")
    if "://" in low or low.startswith("localhost"):
        return ""
    for ext in _DOCUMENT_EXTS:
        if low.endswith(ext):
            return (
                f"ERROR: '{target}' is a local {ext} document, not a web page. "
                "browser_navigate only opens http(s) URLs or workspace HTML files. "
                f"Use read_file(path={target!r}) to get its text "
                "(docx/pptx/xlsx/pdf are converted automatically), or search_text "
                "to locate it. Do not retry browser_navigate for this file."
            )
    return ""


def register_browser_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws

    # Capability B: agent browser tools on the CDP sandbox session (same host as Select Mode).
    def browser_navigate(url: str = "") -> str:
        from ...core.hostinfo import network_available
        from ...core.netguard import blocked_http_reason
        from ...services.browser_preview import is_preview_http_url
        from ...services.browser_sandbox import (
            SANDBOX,
            coerce_navigate_target,
            urls_match,
        )

        target = (url or "").strip()
        if not target:
            return "ERROR: empty url"
        from ...services.browser_sandbox import _looks_like_asset_filename

        shot = _looks_like_asset_filename(target)
        try:
            resolved = coerce_navigate_target(target)
        except ValueError as exc:
            return f"ERROR: {exc}"
        if not resolved:
            doc_hint = _local_document_hint(target)
            if doc_hint:
                return doc_hint
            return (
                "ERROR: invalid url — browser_navigate needs a full http(s) URL "
                "(e.g. https://example.com), localhost:port, or a workspace HTML file "
                "(e.g. report.html). Do not pass screenshot filenames like foo.png "
                "unless a sidecar recorded the page URL."
            )
        if resolved != "about:blank" and not is_preview_http_url(resolved):
            reason = blocked_http_reason(resolved, allow_loopback=False)
            if reason:
                return (
                    f"ERROR: navigation blocked ({reason}). "
                    "Loopback and private networks are not allowed from the agent. "
                    "Open local apps from the browser panel, or pass a workspace HTML file."
                )
            low = resolved.lower()
            public_http = low.startswith("http://") or low.startswith("https://")
            if public_http and not network_available():
                return (
                    "ERROR: this host is offline; cannot open public URLs. "
                    "Use a workspace-relative HTML file."
                )
        current = SANDBOX.last_url()
        if current and urls_match(current, resolved):
            payload = {
                "host": SANDBOX.host_kind(),
                "url": current,
                "ready": True,
                "already": True,
                "note": "already on this page — do not call browser_navigate again with the same url",
            }
            if shot:
                payload["recovered_from"] = target
            return json.dumps(payload, ensure_ascii=False)
        try:
            info = SANDBOX.navigate(target)
            if shot and isinstance(info, dict):
                info = dict(info)
                info["recovered_from"] = target
                info["note"] = (
                    f"You passed a screenshot path; opened the page it was taken from: {resolved}"
                )
            return json.dumps(info, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_screenshot(full_page: bool = False, name: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            path = SANDBOX.save_screenshot_to_workspace(
                live_ws(),
                name=(name or "").strip(),
                full_page=bool(full_page),
            )
            from ...core.pathutil import relative_to_posix

            rel = relative_to_posix(path, live_ws())
            return json.dumps({"path": rel, "abs": str(path)}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_console(limit: int = 40) -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            logs = SANDBOX.console_logs(limit=int(limit) if limit else 40)
            return json.dumps({"count": len(logs), "logs": logs}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_get_page_content(max_chars: int = 12000, include_html: bool = False) -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return json.dumps(
                SANDBOX.page_content(
                    max_chars=int(max_chars or 12000), include_html=bool(include_html)
                ),
                ensure_ascii=False,
            )
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_click(selector: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.click_selector(selector)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_type(selector: str = "", text: str = "", clear: bool = True) -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.type_text(selector, text, clear=bool(clear))
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_scroll(direction: str = "down", amount: int = 0, selector: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            info = SANDBOX.scroll(
                direction=direction or "down",
                amount=int(amount) if amount else None,
                selector=selector or "",
            )
            return json.dumps(info, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_hover(selector: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.hover_selector(selector)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_press_key(key: str = "", selector: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.press_key(key, selector=selector or "")
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_wait(selector: str = "", state: str = "visible", timeout_ms: int = 8000) -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.wait_for(
                selector=selector or "",
                state=state or "visible",
                timeout_ms=int(timeout_ms or 8000),
            )
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_go_back() -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return json.dumps(SANDBOX.go_back(), ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_go_forward() -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            return json.dumps(SANDBOX.go_forward(), ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_find_elements(limit: int = 60) -> str:
        from ...services.browser_sandbox import SANDBOX

        try:
            items = SANDBOX.list_interactive_elements(limit=int(limit) if limit else 60)
            return json.dumps({"count": len(items), "elements": items}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    reg.register(
        Tool(
            "browser_navigate",
            "Open a WEB PAGE in the in-app Browser panel (same window the user "
            "already sees — never a popup). Pass a full URL like https://example.com, "
            "a bare domain like example.com, localhost:port, or a workspace-relative "
            "HTML file (e.g. report.html). NOT for local documents: .docx/.pdf/.xlsx/"
            ".txt/.md etc. must go through read_file. Never pass screenshot "
            "filenames (.png/.jpg). Same session as Select Mode.",
            {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
            browser_navigate,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_screenshot",
            "Capture the sandbox browser viewport to .sidekick/browser/*.png in the workspace.",
            {
                "type": "object",
                "properties": {
                    "full_page": {"type": "boolean", "default": False},
                    "name": {"type": "string", "description": "Optional filename"},
                },
                "required": [],
            },
            browser_screenshot,
            parallel_safe=False,
        )
    )
    # Compatibility names used by earlier prompt packs.  Keep these as real
    # tools (rather than only executor aliases) so the model sees them in its
    # advertised capability list and does not receive an unknown-tool error.
    reg.register(
        Tool(
            "browser_snapshot",
            "Compatibility alias for browser_screenshot. Capture the current browser page to a PNG.",
            {
                "type": "object",
                "properties": {
                    "full_page": {"type": "boolean", "default": False},
                    "name": {"type": "string", "description": "Optional filename"},
                },
                "required": [],
            },
            browser_screenshot,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_get_page_content",
            "Read rendered text from the current browser page. Set include_html only when markup is needed.",
            {
                "type": "object",
                "properties": {
                    "max_chars": {"type": "integer", "default": 12000},
                    "include_html": {"type": "boolean", "default": False},
                },
                "required": [],
            },
            browser_get_page_content,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "browser_console",
            "Read recent console messages from the sandbox browser session.",
            {
                "type": "object",
                "properties": {"limit": {"type": "integer", "default": 40}},
                "required": [],
            },
            browser_console,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "browser_click",
            "Click an element in the sandbox browser by CSS selector (or Playwright selector).",
            {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
            browser_click,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_type",
            "Type text into an input in the sandbox browser (fill by default).",
            {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "text": {"type": "string"},
                    "clear": {"type": "boolean", "default": True},
                },
                "required": ["selector", "text"],
            },
            browser_type,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_find_elements",
            "List clickable/typeable elements on the current page (links, buttons, "
            "inputs, roles) with a ready-to-use CSS selector for each. Call this "
            "before browser_click/browser_type when you don't already know the "
            "exact selector — much more reliable than guessing from raw HTML.",
            {
                "type": "object",
                "properties": {"limit": {"type": "integer", "default": 60}},
                "required": [],
            },
            browser_find_elements,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "browser_scroll",
            "Scroll the sandbox browser page. Use direction=down/up to page by "
            "`amount` pixels (default ~800), direction=top/bottom to jump to an "
            "edge, or pass a selector to scroll a specific element into view.",
            {
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["down", "up", "top", "bottom"],
                        "default": "down",
                    },
                    "amount": {"type": "integer", "description": "Pixels, when not top/bottom"},
                    "selector": {
                        "type": "string",
                        "description": "Scroll this element into view instead of the page",
                    },
                },
                "required": [],
            },
            browser_scroll,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_hover",
            "Hover the mouse over an element in the sandbox browser (reveals "
            "hover menus/tooltips without clicking).",
            {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
            browser_hover,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_press_key",
            "Press a keyboard key in the sandbox browser (e.g. Enter, Tab, Escape, "
            "ArrowDown). Optionally focus `selector` first. Enter often submits a "
            "form — treat like a click.",
            {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "e.g. Enter, Tab, Escape"},
                    "selector": {"type": "string", "description": "Focus this element first"},
                },
                "required": ["key"],
            },
            browser_press_key,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_wait",
            "Wait for the sandbox browser page to settle: pass `selector` to wait "
            "for it to become visible/hidden/attached/detached, or omit it to just "
            "pause (e.g. while a page finishes loading or animating).",
            {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "state": {
                        "type": "string",
                        "enum": ["visible", "hidden", "attached", "detached"],
                        "default": "visible",
                    },
                    "timeout_ms": {"type": "integer", "default": 8000},
                },
                "required": [],
            },
            browser_wait,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_go_back",
            "Navigate back in the sandbox browser's history.",
            {"type": "object", "properties": {}, "required": []},
            browser_go_back,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_go_forward",
            "Navigate forward in the sandbox browser's history.",
            {"type": "object", "properties": {}, "required": []},
            browser_go_forward,
            parallel_safe=False,
        )
    )
