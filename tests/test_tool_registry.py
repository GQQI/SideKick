from __future__ import annotations

from metateam.runtime.tool_registry import (
    Tool,
    ToolRegistry,
    plan_parallel_batches,
    skill_tool_name,
)


def _tc(name: str) -> dict:
    return {"function": {"name": name}, "id": name}


def test_skill_tool_name_normalizes() -> None:
    assert skill_tool_name("My Skill!") == "skill_my_skill"
    assert skill_tool_name("foo--bar") == "skill_foo_bar"
    assert skill_tool_name("___") == "skill_"


def test_plan_parallel_batches_groups_safe() -> None:
    reg = ToolRegistry()
    reg.register(Tool("read_file", "d", {}, lambda: "ok", parallel_safe=True))
    reg.register(Tool("list_dir", "d", {}, lambda: "ok", parallel_safe=True))
    reg.register(Tool("write_file", "d", {}, lambda: "ok", parallel_safe=False))
    batches = plan_parallel_batches(
        [_tc("read_file"), _tc("list_dir"), _tc("write_file"), _tc("read_file")],
        reg,
    )
    assert len(batches) == 3
    assert [c["id"] for c in batches[0]] == ["read_file", "list_dir"]
    assert [c["id"] for c in batches[1]] == ["write_file"]
    assert [c["id"] for c in batches[2]] == ["read_file"]


def test_schemas_hide_mutating_when_disallowed() -> None:
    reg = ToolRegistry()
    reg.register(Tool("read_file", "d", {"type": "object"}, lambda: "ok"))
    reg.register(
        Tool("write_file", "d", {"type": "object"}, lambda: "ok", requires_approval=True)
    )
    names = {s["function"]["name"] for s in reg.schemas(allow_mutating=False)}
    assert names == {"read_file"}
