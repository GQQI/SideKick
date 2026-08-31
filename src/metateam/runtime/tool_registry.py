"""Tool descriptor, registry, and parallel-batch planning."""

from __future__ import annotations

import inspect
import re
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


_ARG_ALIASES: dict[str, dict[str, tuple[str, ...]]] = {
    "search_text": {
        "query": ("query", "pattern", "text", "search", "q", "needle", "keyword"),
        "path": ("path", "file", "filepath", "dir", "directory"),
        "glob": ("glob", "include", "file_glob"),
    },
    "read_file": {
        "path": ("path", "file", "filepath", "filename"),
        "offset": ("offset", "start", "start_line"),
        "limit": ("limit", "count", "max_lines"),
    },
    "write_file": {
        "path": ("path", "file", "filepath"),
        "content": ("content", "text", "body", "data"),
    },
    "str_replace": {
        "path": ("path", "file", "filepath"),
        "old_string": ("old_string", "old_str", "oldString", "search"),
        "new_string": ("new_string", "new_str", "newString", "replace"),
    },
    "list_dir": {
        "path": ("path", "dir", "directory", "folder"),
    },
}


def alias_tool_args(name: str, args: dict[str, Any] | None) -> dict[str, Any]:
    """Map common model aliases (pattern→query) onto the handler's real names."""
    raw = dict(args or {})
    mapping = _ARG_ALIASES.get((name or "").strip(), {})
    out = dict(raw)
    for dest, sources in mapping.items():
        present = out.get(dest)
        if present not in (None, ""):
            continue
        for src in sources:
            if src == dest:
                continue
            value = raw.get(src)
            if value not in (None, ""):
                out[dest] = value
                break
    return out


def coerce_bound_args(handler: Callable[..., Any], args: dict[str, Any]) -> dict[str, Any]:
    """Coerce ints/bools so XML bleed like '200\\n<parameter=offset>' does not crash."""
    try:
        sig = inspect.signature(handler)
    except (TypeError, ValueError):
        return args
    out = dict(args)
    for key, param in sig.parameters.items():
        if key not in out:
            continue
        default = param.default if param.default is not inspect.Parameter.empty else None
        ann = param.annotation
        origin = getattr(ann, "__origin__", None)
        if origin is not None:
            continue
        if ann is int or isinstance(default, int):
            fallback = default if isinstance(default, int) else 0
            out[key] = _as_int(out[key], fallback)
        elif ann is bool or isinstance(default, bool):
            out[key] = _as_bool(out[key], bool(default) if isinstance(default, bool) else False)
    return out


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    text = str(value or "").strip()
    match = re.match(r"-?\d+", text)
    if match:
        try:
            return int(match.group(0))
        except ValueError:
            return default
    return default


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off", ""}:
        return False
    return default


def prepare_tool_args(
    name: str, handler: Callable[..., Any], args: dict[str, Any] | None
) -> dict[str, Any]:
    aliased = alias_tool_args(name, args)
    bound = bind_tool_args(handler, aliased)
    return coerce_bound_args(handler, bound)


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
