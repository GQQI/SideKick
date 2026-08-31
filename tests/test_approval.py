from __future__ import annotations

import threading
import time
from pathlib import Path

from metateam.runtime.approval import (
    APPROVAL_TOOLS,
    OUTSIDE_WORKSPACE_SCOPE,
    ApprovalGate,
    approval_required,
    approval_scope,
    summarize_tool_call,
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


def test_serialize_ui_one_pending_at_a_time() -> None:
    gate = ApprovalGate(timeout_sec=5)
    started = threading.Event()

    def first() -> None:
        with gate.serialize_ui():
            started.set()
            gate.request("a", "write_file", {}, "a")

    def second() -> None:
        started.wait(timeout=2)
        with gate.serialize_ui():
            gate.request("b", "run_shell", {}, "b")

    t1 = threading.Thread(target=first)
    t2 = threading.Thread(target=second)
    t1.start()
    for _ in range(80):
        if any(p["id"] == "a" for p in gate.pending()):
            break
        time.sleep(0.025)
    t2.start()
    time.sleep(0.08)
    assert [p["id"] for p in gate.pending()] == ["a"]
    gate.decide("a", True)
    for _ in range(80):
        if any(p["id"] == "b" for p in gate.pending()):
            break
        time.sleep(0.025)
    assert any(p["id"] == "b" for p in gate.pending())
    gate.decide("b", True)
    t1.join(timeout=2)
    t2.join(timeout=2)
    assert not t1.is_alive() and not t2.is_alive()


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


def test_inside_read_skips_approval(tmp_path: Path) -> None:
    assert not approval_required(
        "read_file",
        args={"path": "notes.md"},
        workspace=tmp_path,
    )
    assert not approval_required(
        "list_dir",
        args={"path": "."},
        workspace=tmp_path,
    )
    assert approval_required(
        "write_file",
        args={"path": "notes.md", "content": "x"},
        workspace=tmp_path,
    )


def test_outside_file_ops_require_approval(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"secret-{tmp_path.name}.txt"
    outside.write_text("nope", encoding="utf-8")
    assert approval_scope("read_file", {"path": str(outside)}, tmp_path) == OUTSIDE_WORKSPACE_SCOPE
    assert approval_required("read_file", args={"path": str(outside)}, workspace=tmp_path)
    assert approval_required("write_file", args={"path": str(outside), "content": "x"}, workspace=tmp_path)
    assert approval_required("list_dir", args={"path": str(outside.parent)}, workspace=tmp_path)
    summary = summarize_tool_call("read_file", {"path": str(outside)}, workspace=tmp_path)
    assert summary.startswith("工作区外 ·")
    inside = summarize_tool_call("read_file", {"path": "a.txt"}, workspace=tmp_path)
    assert not inside.startswith("工作区外")


def test_remember_outside_workspace_does_not_preapprove_inside_writes(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"out-{tmp_path.name}.txt"
    outside.write_text("x", encoding="utf-8")
    gate = ApprovalGate(timeout_sec=5)
    result: dict[str, bool] = {}

    def worker() -> None:
        result["ok"] = gate.request(
            "out1",
            "read_file",
            {"path": str(outside)},
            "工作区外 · 读取",
            scope=OUTSIDE_WORKSPACE_SCOPE,
        )

    t = threading.Thread(target=worker)
    t.start()
    for _ in range(80):
        if gate.pending():
            break
    assert gate.pending()
    assert gate.pending()[0]["tool"] == "read_file"
    gate.decide("out1", True, remember=True)
    t.join(timeout=2)
    assert result.get("ok") is True
    assert gate.is_preapproved(OUTSIDE_WORKSPACE_SCOPE)
    assert not gate.is_preapproved("write_file")
    assert not gate.is_preapproved("read_file")
    assert gate.is_preapproved(approval_scope("write_file", {"path": str(outside)}, tmp_path))
