"""CDP browser sandbox tools (navigate / screenshot / click / type)."""

from __future__ import annotations

import json

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_browser_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws

    # Capability B: agent browser tools on the CDP sandbox session (same host as Select Mode).
    def browser_navigate(url: str = "") -> str:
        from ...services.browser_sandbox import SANDBOX

        target = (url or "").strip()
        if not target:
            return "ERROR: empty url"
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
            "Open a URL in Sidekick's CDP browser sandbox (Playwright Chromium). "
            "Prefer http://127.0.0.1 or http://localhost for local apps. "
            "Starts a headed session if needed. Same session as Select Mode.",
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
