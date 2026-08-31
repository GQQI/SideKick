"""Workspace path fencing — Windows-safe (case, slash, trailing sep)."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import unquote, urlparse


_WIN_DRIVE = re.compile(r"^([A-Za-z]):(?:/(.*))?$")


def resolve_path(path: Path | str) -> Path:
    p = Path(path).expanduser()
    try:
        return p.resolve()
    except OSError:
        return p


def _windows_drive_ready(letter: str) -> bool:
    try:
        return Path(f"{letter}:/").exists()
    except OSError:
        return False


def _strip_file_uri(text: str) -> str:
    if not text.lower().startswith("file:"):
        return text
    parsed = urlparse(text)
    path = unquote(parsed.path or "")
    if os.name == "nt" and re.match(r"^/[A-Za-z]:", path):
        path = path[1:]
    return path or text


def _remap_into_workspace(rel: str, workspace: Path) -> Path:
    """Map a foreign absolute tail into this workspace."""
    rel = (rel or "").replace("\\", "/").strip("/")
    ws = resolve_path(workspace)
    if not rel or rel in (".",):
        return ws
    parts = [p for p in rel.split("/") if p and p not in (".",)]
    if not parts:
        return ws
    ws_name = ws.name
    matches = [i for i, p in enumerate(parts) if p.lower() == ws_name.lower()]
    if matches:
        tail = parts[matches[-1] + 1 :]
        return resolve_path(ws.joinpath(*tail)) if tail else ws
    return resolve_path(ws.joinpath(*parts))


def normalize_user_path(raw: str | Path, workspace: Path) -> Path:
    """Resolve a tool/user path onto THIS host.

    Relative → workspace. Real local absolute → kept. Windows drive letters
    that do not exist here (or that appear on Linux/麒麟) are remapped into
    the workspace so write_file does not fail on another machine.
    """
    text = str(raw or ".").strip().strip('"').strip("'") or "."
    text = _strip_file_uri(text)
    text = text.strip() or "."
    unified = text.replace("\\", "/")
    ws = resolve_path(workspace)

    if unified in (".", "./"):
        return ws

    drive_m = _WIN_DRIVE.match(unified)
    if drive_m:
        letter = drive_m.group(1).upper()
        rest = (drive_m.group(2) or "").lstrip("/")
        if os.name == "nt" and _windows_drive_ready(letter):
            abs_s = f"{letter}:/{rest}" if rest else f"{letter}:/"
            resolved = resolve_path(Path(abs_s))
            if is_relative_to(resolved, ws):
                return resolved
            # Keep a real path on this PC; remap leftover paths from another machine.
            try:
                if resolved.exists() or resolved.parent.exists():
                    return resolved
            except OSError:
                pass
            return _remap_into_workspace(rest, ws)
        return _remap_into_workspace(rest, ws)

    if unified.startswith("//"):
        if os.name == "nt":
            return resolve_path(Path(unified))
        parts = [p for p in unified.split("/") if p]
        tail = "/".join(parts[2:]) if len(parts) > 2 else ""
        return _remap_into_workspace(tail, ws)

    # POSIX absolute arriving on Windows (`/home/...`) is "absolute" here but
    # usually means another machine — remap unless it already exists.
    if os.name == "nt" and unified.startswith("/") and not unified.startswith("//"):
        candidate = Path(unified)
        try:
            if candidate.exists():
                return resolve_path(candidate)
        except OSError:
            pass
        return _remap_into_workspace(unified.lstrip("/"), ws)

    p = Path(text).expanduser()
    if p.is_absolute():
        return resolve_path(p)
    return resolve_path(ws / Path(*[x for x in unified.split("/") if x and x != "."]))


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


def path_outside_workspace(raw: str | Path, workspace: Path | str) -> bool:
    """True when a tool path resolves to a location outside the workspace."""
    text = str(raw or "").strip()
    root = str(workspace or "").strip()
    if not text or not root:
        return False
    try:
        resolved = normalize_user_path(text, Path(root))
    except Exception:
        return True
    return not is_relative_to(resolved, Path(root))
