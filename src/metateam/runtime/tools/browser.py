"""CDP browser sandbox tools (navigate / screenshot / click / type)."""

from __future__ import annotations

import json

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_browser_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws

    # Capability B: agent browser tools on the CDP sandbox session (same host as Select Mode).
    def browser_navigate(url: str = "") -> str:
        from ...core.hostinfo import network_available
        from ...core.netguard import blocked_http_reason
        from ...services.browser_preview import is_preview_http_url
        from ...services.browser_sandbox import SANDBOX, resolve_browser_target

        target = (url or "").strip()
        if not target:
            return "ERROR: empty url"
        resolved = resolve_browser_target(target)
        if not resolved:
            return (
                "ERROR: invalid url — browser_navigate opens public http(s) links, "
                "or a workspace-relative HTML file (e.g. report.html)."
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
        try:
            info = SANDBOX.navigate(target)
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

    reg.register(
        Tool(
            "browser_navigate",
            "Open a public http(s) URL in Sidekick's CDP browser sandbox (Playwright Chromium). "
            "Loopback and private networks are blocked. For local HTML, pass a "
            "workspace-relative path (e.g. report.html). Same session as Select Mode.",
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
