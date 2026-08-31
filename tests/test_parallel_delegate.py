"""Regression: multiple separate delegate_task tool_calls must run concurrently.

Some models emit N separate delegate_task tool_calls in one assistant turn
(one per worker) instead of a single call with tasks=[...]. Before this fix,
delegate_task was registered with parallel_safe=False, so plan_parallel_batches
isolated each call into its own batch and _execute_tools ran them strictly
one-at-a-time — the opposite of what the user asked for when requesting
"run 3 agents in parallel".
"""

from __future__ import annotations

import threading
import time
from typing import Any

from metateam.core.config import Settings
from metateam.core.guardrails import Guardrails
from metateam.runtime.agent_execute import AgentExecuteMixin
from metateam.runtime.approval import ApprovalGate
from metateam.runtime.tool_registry import Tool, ToolRegistry, plan_parallel_batches


class _FakeAgent(AgentExecuteMixin):
    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry
        self.settings = Settings()
        self.settings.tool_result_cap = 100_000
        self.approval = ApprovalGate()
        self.guard = Guardrails()
        self.is_subagent = False
        self.goal = ""
        self.role = "leaf"
        self._allow_mutating_tools = True
        self._turn_mutated = False
        self._turn_verified = False
        self._delegate_slots_remaining = self.settings.max_concurrent_children
        self.events: list[tuple[str, dict[str, Any]]] = []

    def _emit(self, type_: str, data: dict[str, Any] | None = None) -> None:
        self.events.append((type_, data or {}))

    def cancelled(self) -> bool:
        return False

    def _ingest_workspace_fact(self, name: str, args: dict[str, Any], content: str) -> None:
        return None


def _tc(name: str, call_id: str) -> dict[str, Any]:
    return {"id": call_id, "function": {"name": name, "arguments": "{}"}}


def test_delegate_task_tool_is_registered_parallel_safe() -> None:
    """The real registration must opt delegate_task into parallel batching."""
    from metateam.runtime.tools.context import ToolContext
    from metateam.runtime.tools.delegate import register_ask_and_delegate

    settings = Settings()
    reg = ToolRegistry()
    register_ask_and_delegate(
        reg,
        ToolContext(settings=settings, skills=[], run_child=lambda **kw: "ok"),
    )
    tool = reg.get("delegate_task")
    assert tool is not None
    assert tool.parallel_safe is True


def test_browser_compatibility_tools_are_registered() -> None:
    from metateam.runtime.tools.browser import register_browser_tools
    from metateam.runtime.tools.context import ToolContext

    reg = ToolRegistry()
    register_browser_tools(reg, ToolContext(settings=Settings(), skills=[]))
    assert reg.get("browser_snapshot") is not None
    assert reg.get("browser_get_page_content") is not None


def test_three_separate_delegate_task_calls_batch_together() -> None:
    reg = ToolRegistry()
    reg.register(Tool("delegate_task", "d", {}, lambda: "ok", parallel_safe=True))
    reg.register(Tool("write_file", "d", {}, lambda: "ok", parallel_safe=False))

    calls = [
        _tc("delegate_task", "d1"),
        _tc("delegate_task", "d2"),
        _tc("delegate_task", "d3"),
    ]
    batches = plan_parallel_batches(calls, reg)
    assert len(batches) == 1
    assert [c["id"] for c in batches[0]] == ["d1", "d2", "d3"]

    # A mutating call in between still isolates the groups around it.
    mixed = [
        _tc("delegate_task", "d1"),
        _tc("write_file", "w1"),
        _tc("delegate_task", "d2"),
        _tc("delegate_task", "d3"),
    ]
    batches2 = plan_parallel_batches(mixed, reg)
    assert [[c["id"] for c in b] for b in batches2] == [["d1"], ["w1"], ["d2", "d3"]]


def test_delegate_task_allows_more_than_max_children() -> None:
    import json

    from metateam.runtime.tools.context import ToolContext
    from metateam.runtime.tools.delegate import register_ask_and_delegate

    seen: list[str] = []

    def run_child(*, goal: str, context: str = "", role: str = "leaf", **_kw: Any) -> str:
        seen.append(goal)
        return f"ok:{goal}"

    settings = Settings()
    settings.max_concurrent_children = 3
    reg = ToolRegistry()
    register_ask_and_delegate(
        reg,
        ToolContext(settings=settings, skills=[], run_child=run_child),
    )
    tool = reg.get("delegate_task")
    assert tool is not None
    out = tool.handler(tasks=[{"goal": f"t{i}"} for i in range(4)])
    assert not str(out).startswith("ERROR")
    payload = json.loads(out)
    assert len(payload) == 4
    assert sorted(seen) == ["t0", "t1", "t2", "t3"]


def test_multiple_delegate_task_calls_actually_overlap_in_time() -> None:
    starts: list[float] = []
    ends: list[float] = []
    gap = 0.15
    lock = threading.Lock()

    def slow_delegate() -> str:
        with lock:
            starts.append(time.monotonic())
        time.sleep(gap)
        with lock:
            ends.append(time.monotonic())
        return "ok"

    reg = ToolRegistry()
    reg.register(
        Tool("delegate_task", "d", {"type": "object", "properties": {}}, slow_delegate, parallel_safe=True)
    )

    agent = _FakeAgent(reg)
    tool_calls = [_tc("delegate_task", f"c{i}") for i in range(3)]

    t0 = time.monotonic()
    results = agent._execute_tools(tool_calls)
    elapsed = time.monotonic() - t0

    assert len(results) == 3
    assert all(r["content"] == "ok" for r in results)
    # Serialized execution would take ~3x gap; true concurrency keeps it near 1x.
    assert elapsed < gap * 2.2, f"expected overlap, took {elapsed:.3f}s for 3x{gap}s calls"
    assert len(starts) == 3
    # The third call must have started before the first one finished.
    assert max(starts) < min(ends) + 0.05


def test_delegate_task_notes_all_canvas_slots_before_running() -> None:
    from metateam.runtime.tools.context import ToolContext
    from metateam.runtime.tools.delegate import register_ask_and_delegate

    noted: list[list[dict[str, Any]]] = []

    def run_child(*, goal: str, context: str = "", role: str = "leaf", **_kw: Any) -> str:
        return f"ok:{goal}"

    def note_canvas_tasks(items: list[dict[str, Any]]) -> None:
        noted.append(list(items))

    settings = Settings()
    settings.max_concurrent_children = 3
    reg = ToolRegistry()
    register_ask_and_delegate(
        reg,
        ToolContext(
            settings=settings,
            skills=[],
            run_child=run_child,
            note_canvas_tasks=note_canvas_tasks,
        ),
    )
    tool = reg.get("delegate_task")
    assert tool is not None
    tool.handler(tasks=[{"goal": f"t{i}"} for i in range(5)])
    assert len(noted) == 1
    assert [row["goal"] for row in noted[0]] == [f"t{i}" for i in range(5)]
    assert len({row["child_id"] for row in noted[0]}) == 5

