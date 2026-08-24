"""Durable MEMORY.md — injected into system prompt (truncated)."""

from __future__ import annotations

import re
from pathlib import Path


def read_memory(path: Path, max_chars: int = 4000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8").strip()
    if len(text) > max_chars:
        return text[: max_chars - 20] + "\n…[memory truncated]"
    return text


def write_memory(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def append_memory(path: Path, note: str) -> str:
    cur = read_memory(path, max_chars=200_000)
    note = note.strip()
    if not note:
        return "empty note"
    if note in cur:
        return "already present"
    new = (cur + "\n\n- " + note).strip() + "\n"
    write_memory(path, new)
    return "saved"


def remove_memory(path: Path, match: str) -> str:
    """Remove bullet/paragraph lines that contain `match` (case-insensitive)."""
    needle = (match or "").strip()
    if not needle:
        return "empty match"
    cur = read_memory(path, max_chars=200_000)
    if not cur:
        return "memory empty"
    if needle not in cur and needle.lower() not in cur.lower():
        return f"not found: {needle[:80]}"

    lines = cur.splitlines()
    kept: list[str] = []
    removed = 0
    needle_l = needle.lower()
    for line in lines:
        if needle_l in line.lower():
            removed += 1
            continue
        kept.append(line)

    # Also drop orphan blank lines left by removals
    text = "\n".join(kept)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if removed == 0:
        # Fallback: remove the first occurrence of the substring anywhere
        pattern = re.compile(re.escape(needle), re.IGNORECASE)
        new_text, n = pattern.subn("", cur, count=1)
        if n == 0:
            return f"not found: {needle[:80]}"
        text = re.sub(r"\n{3,}", "\n\n", new_text).strip()
        removed = n

    write_memory(path, text + "\n" if text else "# MEMORY\n\n")
    return f"removed {removed} match(es)"


def replace_memory(path: Path, content: str) -> str:
    """Overwrite MEMORY.md entirely (use after memory_read + edit)."""
    write_memory(path, content if content is not None else "")
    return "replaced"


def format_memory_block(path: Path) -> str:
    text = read_memory(path)
    if not text:
        return ""
    return "## Memory\nFacts that persist across sessions. Keep updates compact.\n" + text
