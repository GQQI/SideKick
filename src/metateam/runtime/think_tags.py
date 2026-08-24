"""Split <think>…</think> / <thinking>…</thinking> from model content streams."""

from __future__ import annotations

import re
from typing import Iterable

_THINK_OPEN = re.compile(r"<(think|thinking)\s*>", re.IGNORECASE)
_THINK_CLOSE = re.compile(r"</(think|thinking)\s*>", re.IGNORECASE)
_OPEN_PREFIXES = (
    "<",
    "<t",
    "<th",
    "<thi",
    "<thin",
    "<think",
    "<thinking",
    "<think>",
    "<thinking>",
)
_CLOSE_PREFIXES = (
    "<",
    "</",
    "</t",
    "</th",
    "</thi",
    "</thin",
    "</think",
    "</thinking",
    "</think>",
    "</thinking>",
)


def _partial_suffix_len(buf: str, prefixes: tuple[str, ...]) -> int:
    if not buf:
        return 0
    low = buf.lower()
    max_keep = 0
    for i in range(1, min(len(low), 12) + 1):
        suffix = low[-i:]
        if any(p.startswith(suffix) for p in prefixes):
            max_keep = i
    return max_keep


def split_think_tags(text: str) -> tuple[str, str]:
    """Split a complete string into (visible_content, thinking_content)."""
    if not text:
        return "", ""
    splitter = ThinkTagSplitter()
    content_parts: list[str] = []
    reason_parts: list[str] = []
    for kind, piece in list(splitter.feed(text)) + list(splitter.flush()):
        if kind == "reasoning":
            reason_parts.append(piece)
        else:
            content_parts.append(piece)
    return "".join(content_parts), "".join(reason_parts)


class ThinkTagSplitter:
    """Incremental splitter for streamed content that embeds think tags.

    Tag interiors are treated as reasoning; everything outside is visible content.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False

    def feed(self, text: str) -> list[tuple[str, str]]:
        if not text:
            return []
        self._buf += text
        out: list[tuple[str, str]] = []
        while True:
            if not self._in_think:
                m = _THINK_OPEN.search(self._buf)
                if not m:
                    keep = _partial_suffix_len(self._buf, _OPEN_PREFIXES)
                    emit = self._buf[:-keep] if keep else self._buf
                    self._buf = self._buf[-keep:] if keep else ""
                    if emit:
                        out.append(("content", emit))
                    break
                before = self._buf[: m.start()]
                if before:
                    out.append(("content", before))
                self._buf = self._buf[m.end() :]
                self._in_think = True
            else:
                m = _THINK_CLOSE.search(self._buf)
                if not m:
                    keep = _partial_suffix_len(self._buf, _CLOSE_PREFIXES)
                    emit = self._buf[:-keep] if keep else self._buf
                    self._buf = self._buf[-keep:] if keep else ""
                    if emit:
                        out.append(("reasoning", emit))
                    break
                inside = self._buf[: m.start()]
                if inside:
                    out.append(("reasoning", inside))
                self._buf = self._buf[m.end() :]
                self._in_think = False
        return out

    def flush(self) -> list[tuple[str, str]]:
        if not self._buf:
            return []
        kind = "reasoning" if self._in_think else "content"
        piece = self._buf
        self._buf = ""
        return [(kind, piece)] if piece else []

    def reset(self) -> None:
        self._buf = ""
        self._in_think = False
