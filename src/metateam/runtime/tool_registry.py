"""Tool descriptor, registry, and parallel-batch planning."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., str]
    parallel_safe: bool = False
    requires_approval: bool = False

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def schemas(self, *, allow_mutating: bool = True) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for tool in self._tools.values():
            if not allow_mutating and (
                tool.requires_approval or tool.name in ("delegate_task", "delegate_dialogue")
            ):
                continue
            out.append(tool.openai_schema())
        return out

    def names(self) -> list[str]:
        return sorted(self._tools.keys())


def bind_tool_args(handler: Callable[..., Any], args: dict[str, Any]) -> dict[str, Any]:
    """Drop unknown kwargs so models can pass extra fields like description."""
    cleaned = {
        str(k): v for k, v in (args or {}).items() if not str(k).startswith("_")
    }
    try:
        sig = inspect.signature(handler)
    except (TypeError, ValueError):
        return cleaned
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
        return cleaned
    allowed = {
        name
        for name, p in sig.parameters.items()
        if p.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
        and name not in ("self", "cls")
    }
    return {k: v for k, v in cleaned.items() if k in allowed}


def skill_tool_name(name: str) -> str:
    # Normalize to [a-z0-9_] for broad provider compatibility
    safe = "".join(c if c.isalnum() else "_" for c in name.lower()).strip("_")
    while "__" in safe:
        safe = safe.replace("__", "_")
    return f"skill_{safe}"


def plan_parallel_batches(
    tool_calls: list[dict[str, Any]], registry: ToolRegistry
) -> list[list[dict[str, Any]]]:
    """Group consecutive parallel-safe calls; isolate mutating / sequential tools."""
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for tc in tool_calls:
        name = (tc.get("function") or {}).get("name", "")
        tool = registry.get(name)
        safe = bool(tool and tool.parallel_safe)
        if safe:
            current.append(tc)
        else:
            if current:
                batches.append(current)
                current = []
            batches.append([tc])
    if current:
        batches.append(current)
    return batches
