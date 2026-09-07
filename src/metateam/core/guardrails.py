"""Stop identical tool loops and consecutive explore-only thrashing."""

from __future__ import annotations

import hashlib
import json
import re
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

# Same args, same result — repeating them is a stuck loop, not progress.
_IDEMPOTENT_TOOLS = frozenset(
    {
        "browser_navigate",
        "browser_screenshot",
        "browser_snapshot",
        "browser_get_page_content",
        "browser_console",
        "browser_find_elements",
        "browser_wait",
        "web_search",
    }
)

# Explore tools that may be called again with the same args (Claude: re-fetch
# if you still need the bytes). Identical list_dir/search is still blocked.
_REREAD_OK = frozenset({"read_file"})
_RANGE_TOOLS = frozenset({"read_file"})
_RANGE_META_RE = re.compile(r"lines (\d+)-(\d+) of (\d+)")


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    text = str(value or "").strip()
    m = re.match(r"-?\d+", text)
    if not m:
        return default
    try:
        return int(m.group(0))
    except ValueError:
        return default


def _range_path_key(args: dict[str, Any] | None) -> str:
    raw = str((args or {}).get("path") or "").strip().replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    while "//" in raw:
        raw = raw.replace("//", "/")
    return raw.lower()


@dataclass
class Guardrails:
    same_call_fail_limit: int = 2
    # Identical successful explore calls: 1 means "result is already in history".
    same_call_ok_limit: int = 1
    # Kept for backwards-compatible construction in tests.
    max_reads_per_path: int = 0
    max_reads_total: int = 0
    max_explore_streak: int = 48
    fails: dict[str, int] = field(default_factory=dict)
    ok_counts: dict[str, int] = field(default_factory=dict)
    pending: set[str] = field(default_factory=set)
    blocked: set[str] = field(default_factory=set)
    explore_streak: int = 0
    # Plan-prep / gather-only: consecutive reads are the job, not thrashing.
    explore_only: bool = False
    # path -> merged list of (start, end) inclusive line ranges read this turn.
    read_ranges: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    # path -> total line count, learned from the last successful read.
    read_totals: dict[str, int] = field(default_factory=dict)
    # (path, offset, end) -> how many times this exact covered slice was served a stub.
    stub_serves: dict[tuple[str, int, int], int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def begin_turn(self) -> None:
        """Reset per-user-turn explore budget. Keep fail memory across turns."""
        with self._lock:
            self.explore_streak = 0
            self.ok_counts.clear()
            self.pending.clear()
            self.explore_only = False
            self.read_ranges.clear()
            self.read_totals.clear()
            self.stub_serves.clear()

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

    def _requested_range(self, args: dict[str, Any]) -> tuple[str, int, int] | None:
        path = _range_path_key(args)
        if not path:
            return None
        offset = max(1, _as_int((args or {}).get("offset"), 1))
        limit = _as_int((args or {}).get("limit"), 0)
        total = self.read_totals.get(path)
        if limit > 0:
            req_end = offset + limit - 1
        elif total:
            req_end = total
        else:
            return None
        return path, offset, req_end

    def dedup_read(self, name: str, args: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
        """File-space dedupe (Cursor-style): never resend bytes already in context.

        Returns (served_content, adjusted_args):
        - (stub, None)      → the whole request is already in context; skip the
          handler and return the short stub instead of duplicate payload.
        - (None, new_args)  → head of the request was already read; run the
          handler with offset moved forward so only NEW lines are returned.
        - (None, None)      → nothing covered; run the handler as-is.
        """
        if name not in _RANGE_TOOLS:
            return None, None
        with self._lock:
            req = self._requested_range(args)
            if req is None:
                return None, None
            path, offset, req_end = req
            ranges = self.read_ranges.get(path, [])
            for start, end in ranges:
                if start <= offset and req_end <= end:
                    key = (path, offset, req_end)
                    n = self.stub_serves.get(key, 0) + 1
                    self.stub_serves[key] = n
                    if n >= 2:
                        # Second identical fully-covered request: escalate to
                        # ERROR so the fail-limit blocks a third one outright.
                        return (
                            f"ERROR: you requested lines {offset}-{req_end} of {path} "
                            f"AGAIN ({n}x). That content is already in this conversation. "
                            "Stop calling read_file on it. To FIND something in the file "
                            "use search_text(query=..., path=...); to change it use "
                            "str_replace; otherwise continue the task with what you have.",
                            None,
                        )
                    total = self.read_totals.get(path)
                    if total and start <= 1 and end >= total:
                        return (
                            f"[already in context] The ENTIRE file {path} ({total} lines) "
                            "was returned earlier this turn. You have all of it — stop "
                            "reading this file and continue the task using that content. "
                            "To locate something inside it, use search_text instead.",
                            None,
                        )
                    of_total = f" of {total}" if total else ""
                    return (
                        f"[already in context] lines {offset}-{req_end}{of_total} of {path} "
                        f"were returned earlier this turn (covered {start}-{end}). "
                        "Scroll up and reuse that result. To FIND something in the file "
                        "use search_text; if the file changed, it will be re-read "
                        "automatically after any write.",
                        None,
                    )
            for start, end in ranges:
                # Head overlap: 1-136 already read, request 40-200 → serve 137-200.
                if start <= offset <= end < req_end:
                    new_args = dict(args or {})
                    new_args["offset"] = end + 1
                    new_args["limit"] = req_end - end
                    return None, new_args
        return None, None

    def reset_read_coverage(self) -> None:
        """Compaction removed messages from the window — earlier reads may be
        gone, so dedup must not claim they are still in context."""
        with self._lock:
            self.read_ranges.clear()
            self.read_totals.clear()
            self.stub_serves.clear()

    def read_coverage_lines(self) -> list[str]:
        """Compact ledger of files/ranges already read this turn."""
        with self._lock:
            items: list[str] = []
            for path, ranges in self.read_ranges.items():
                total = self.read_totals.get(path)
                bits = ", ".join(f"{s}-{e}" for s, e in ranges)
                extra = f" of {total}" if total else ""
                items.append(f"{path}: lines {bits}{extra}")
            return items

    def _record_range(self, args: dict[str, Any], content: str) -> None:
        path = _range_path_key(args)
        if not path:
            return
        m = _RANGE_META_RE.search(content or "")
        if not m:
            return
        start, end, total = int(m.group(1)), int(m.group(2)), int(m.group(3))
        self.read_totals[path] = total
        ranges = self.read_ranges.setdefault(path, [])
        ranges.append((start, end))
        ranges.sort()
        merged: list[tuple[int, int]] = []
        for s, e in ranges:
            if merged and s <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], e))
            else:
                merged.append((s, e))
        self.read_ranges[path] = merged

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
            # happen in parallel batches and must not surface as a fake ERROR —
            # except serial tools like browser_navigate, where two loadURLs abort.
            if name in _IDEMPOTENT_TOOLS and sig in self.pending:
                return (
                    f"ERROR: `{name}` with these arguments is already running. "
                    "Wait for that result; do not fire the same call again."
                )
            if ok_n >= self.same_call_ok_limit and name not in _REREAD_OK:
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
                if name in _EXPLORE_TOOLS or name in _IDEMPOTENT_TOOLS:
                    if name not in _REREAD_OK:
                        self.ok_counts[sig] = self.ok_counts.get(sig, 0) + 1
                else:
                    # A successful action can invalidate prior reads/listings.
                    self.ok_counts.clear()
                    self.read_ranges.clear()
                    self.read_totals.clear()
                    self.stub_serves.clear()
                if name in _RANGE_TOOLS:
                    self._record_range(args, content)

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
