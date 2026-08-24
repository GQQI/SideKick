"""Workspace path fencing — Windows-safe (case, slash, trailing sep)."""

from __future__ import annotations

import os
from pathlib import Path


def resolve_path(path: Path | str) -> Path:
    p = Path(path).expanduser()
    try:
        return p.resolve()
    except OSError:
        return p


def is_relative_to(child: Path | str, root: Path | str) -> bool:
    """True if child is root or a descendant. Case-insensitive on Windows."""
    c = resolve_path(child)
    r = resolve_path(root)
    try:
        c.relative_to(r)
        return True
    except ValueError:
        pass
    if os.name == "nt":
        cs = os.path.normcase(os.path.normpath(str(c))).rstrip("\\/")
        rs = os.path.normcase(os.path.normpath(str(r))).rstrip("\\/")
        if cs == rs:
            return True
        return cs.startswith(rs + "\\")
    return False


def relative_to_posix(child: Path | str, root: Path | str) -> str:
    """POSIX-style path relative to root. Raises ValueError if outside."""
    c = resolve_path(child)
    r = resolve_path(root)
    if not is_relative_to(c, r):
        raise ValueError(f"path outside workspace: {c}")
    rel = os.path.relpath(str(c), str(r))
    if rel in (".", ""):
        return "."
    return rel.replace("\\", "/")
