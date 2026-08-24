from __future__ import annotations

import threading
import time

from metateam.runtime.approval import (
    APPROVAL_TOOLS,
    ApprovalGate,
    approval_required,
    tool_needs_approval,
)
from metateam.runtime.tool_registry import Tool


def _dummy_tool(name: str, *, requires_approval: bool) -> Tool:
    return Tool(name, "d", {"type": "object"}, lambda: "ok", requires_approval=requires_approval)


def test_table_covers_browser_and_mcp() -> None:
    assert "browser_navigate" in APPROVAL_TOOLS
    assert "browser_click" in APPROVAL_TOOLS
    assert tool_needs_approval("write_file")
    assert tool_needs_approval("str_replace")
    assert tool_needs_approval("mcp_github_create_issue")
    assert not tool_needs_approval("read_file")
    assert not tool_needs_approval("browser_screenshot")


def test_approval_required_uses_tool_flag() -> None:
    click = _dummy_tool("browser_click", requires_approval=True)
    shot = _dummy_tool("browser_screenshot", requires_approval=False)
    assert approval_required("browser_click", click)
    assert not approval_required("browser_screenshot", shot)
    assert approval_required("mcp_x", None)


def test_patch_merges_into_original_args() -> None:
    gate = ApprovalGate(timeout_sec=5)
    args = {"path": "a.txt", "content": "old"}
    result: dict[str, bool] = {}

    def worker() -> None:
        result["ok"] = gate.request("id1", "write_file", args, "write a.txt")

    t = threading.Thread(target=worker)
    t.start()
    for _ in range(80):
        if gate.pending():
            break
        time.sleep(0.025)
    assert gate.pending()
    gate.decide("id1", True, patch_args={"content": "accepted hunk"})
    t.join(timeout=2)
    assert result.get("ok") is True
    assert args["content"] == "accepted hunk"
    assert args["path"] == "a.txt"
