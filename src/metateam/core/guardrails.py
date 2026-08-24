"""Stop identical tool loops and consecutive explore-only thrashing."""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field
from typing import Any


_PATH_KEY_SUFFIXES = ("path", "file", "dir", "directory")


def _looks_path_key(key: str) -> bool:
    k = (key or "").lower().replace("-", "_")
    if k in {"path", "symbol_or_path"}:
        return True
    return any(k == suffix or k.endswith("_" + suffix) for suffix in _PATH_KEY_SUFFIXES)


def _canonical_value(key: str, value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if _looks_path_key(key):
            text = text.replace("\\", "/")
            while text.startswith("./"):
                text = text[2:]
            while "//" in text:
                text = text.replace("//", "/")
            return text
        if text.isdigit() or (text.startswith("-") and text[1:].isdigit()):
            return int(text)
        return text
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {
            str(k): _canonical_value(str(k), v)
            for k, v in value.items()
            if not str(k).startswith("_")
        }
    if isinstance(value, list):
        return [_canonical_value(key, item) for item in value]
    return value


def _canonical_args(args: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if str(key).startswith("_"):
            continue
        out[str(key)] = _canonical_value(str(key), value)
    return out


def _sig(name: str, args: dict[str, Any] | None) -> str:
    blob = json.dumps(
        {"n": name, "a": _canonical_args(args)},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def tool_call_signature(name: str, args: dict[str, Any] | None) -> str:
    """Stable id for a tool name + canonical args (used by execute / tests)."""
    return _sig(name, args)


def looks_failed(content: str) -> bool:
    low = (content or "")[:400].lower()
    return (
        low.startswith("error")
        or '"error"' in low
        or "traceback" in low
        or low.startswith("failed")
    )


# Tools that only inspect state. Consecutive use without an action means the
# agent is stuck browsing — including read_file, which used to be exempt.
_EXPLORE_TOOLS = frozenset(
    {
        "read_file",
        "list_dir",
        "search_text",
        "codebase_overview",
        "codebase_find_similar",
        "codebase_impact",
        "coherence_checklist",
        "memory_read",
    }
)


@dataclass
class Guardrails:
    same_call_fail_limit: int = 4
    # Identical successful explore calls: 1 means "result is already in history".
    same_call_ok_limit: int = 1
    # Kept for backwards-compatible construction in tests.
    max_reads_per_path: int = 0
    max_reads_total: int = 0
    max_explore_streak: int = 16
    fails: dict[str, int] = field(default_factory=dict)
    ok_counts: dict[str, int] = field(default_factory=dict)
    pending: set[str] = field(default_factory=set)
    blocked: set[str] = field(default_factory=set)
    explore_streak: int = 0
    # Plan-prep / gather-only: consecutive reads are the job, not thrashing.
    explore_only: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def begin_turn(self) -> None:
        """Reset per-user-turn explore budget. Keep fail memory across turns."""
        with self._lock:
            self.explore_streak = 0
            self.ok_counts.clear()
            self.pending.clear()
            self.explore_only = False

    def set_explore_only(self, enabled: bool) -> None:
        with self._lock:
            self.explore_only = bool(enabled)
            if enabled:
                self.explore_streak = 0

    def begin_plan_step(self) -> None:
        """New plan step may explore new files; identical prior reads stay blocked."""
        with self._lock:
            self.explore_streak = 0
            self.pending.clear()

    def before(self, name: str, args: dict[str, Any]) -> str | None:
        sig = _sig(name, args)
        with self._lock:
            if sig in self.blocked or self.fails.get(sig, 0) >= self.same_call_fail_limit:
                self.blocked.add(sig)
                return (
                    f"ERROR: blocked repeated failing call `{name}` with identical args "
                    f"({self.same_call_fail_limit}x). Change strategy or explain the blocker."
                )

            ok_n = self.ok_counts.get(sig, 0)
            # Only block after a completed success. In-flight (pending) duplicates
            # happen in parallel batches and must not surface as a fake ERROR.
            if ok_n >= self.same_call_ok_limit:
                return (
                    f"ERROR: `{name}` with these arguments already returned a result "
                    "this turn (it is in the conversation). Use that result. "
                    "Change the path or query if you still need something new."
                )

            if (
                name in _EXPLORE_TOOLS
                and not self.explore_only
                and self.explore_streak >= self.max_explore_streak
            ):
                return (
                    f"ERROR: explore streak limit ({self.max_explore_streak} consecutive "
                    "read/search tools). Use results already in this conversation, "
                    "ask_user if a decision is still missing, or take a write/edit action."
                )

            self.pending.add(sig)
        return None

    def after(self, name: str, args: dict[str, Any], content: str) -> None:
        sig = _sig(name, args)
        failed = looks_failed(content)
        with self._lock:
            self.pending.discard(sig)
            if failed:
                self.fails[sig] = self.fails.get(sig, 0) + 1
                if self.fails[sig] >= self.same_call_fail_limit:
                    self.blocked.add(sig)
            else:
                self.fails.pop(sig, None)
                if name in _EXPLORE_TOOLS:
                    self.ok_counts[sig] = self.ok_counts.get(sig, 0) + 1
                else:
                    # A successful action can invalidate prior reads/listings.
                    self.ok_counts.clear()

            if name in _EXPLORE_TOOLS:
                self.explore_streak += 1
            else:
                self.explore_streak = 0

    def progress_nudge(self) -> str | None:
        """Deprecated no-op.

        Injecting a new ``role: user`` message made models treat the nudge as a
        fresh task (think → read_file → nudge → think → read_file). Blocking
        happens in ``before()`` instead.
        """
        return None
