"""Workspace path fencing — Windows-safe (case, slash, trailing sep)."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import unquote


_XML_ENTITIES = (
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", '"'),
    ("&#39;", "'"),
)


def clean_tool_path_text(raw: str | Path) -> str:
    """Strip wrapper punctuation / entities without inventing a different name."""
    text = str(raw or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"`", "'", '"'}:
        text = text[1:-1].strip()
    if text.startswith("<") and text.endswith(">") and "/" not in text[1:-1]:
        text = text[1:-1].strip()
    for src, dst in _XML_ENTITIES:
        text = text.replace(src, dst)
    return text.strip()


def _try_unquote(text: str) -> str:
    if "%" not in text:
        return text
    decoded = unquote(text)
    return decoded if decoded else text


def _join_workspace(workspace: Path, unified: str) -> Path:
    parts = [p for p in unified.replace("\\", "/").split("/") if p and p != "."]
    if not parts:
        return resolve_path(workspace)
    return resolve_path(workspace.joinpath(*parts))


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
    """Keep '#', '?' and encoded characters as part of the filename."""
    if not text.lower().startswith("file:"):
        return text
    rest = text[5:]
    if rest.startswith("//"):
        rest = rest[2:]
    rest = unquote(rest)
    unified = rest.replace("\\", "/")
    if os.name == "nt" and re.match(r"^/[A-Za-z]:", unified):
        rest = rest[1:]
    return rest or text


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

    Relative → workspace. Real local absolute → kept (even if the file or
    parent does not exist yet — approval covers writes outside the workspace).
    Windows drive letters that do not exist here (or that appear on
    Linux/麒麟) are remapped into the workspace so leftover paths from
    another machine still resolve.
    """
    text = clean_tool_path_text(raw)
    text = _strip_file_uri(text)
    text = clean_tool_path_text(text) or "."
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
            return resolve_path(Path(abs_s))
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
    return _join_workspace(ws, unified)


def _exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _case_match(parent: Path, name: str) -> Path | None:
    try:
        if not parent.is_dir():
            return None
        wanted = name.lower()
        hits = [child for child in parent.iterdir() if child.name.lower() == wanted]
    except OSError:
        return None
    if len(hits) == 1:
        return hits[0]
    return None


def resolve_existing_tool_path(raw: str | Path, workspace: Path) -> Path:
    """Resolve a tool path, preferring a real file without inventing another name."""
    primary = normalize_user_path(raw, workspace)
    if _exists(primary):
        return primary
    text = clean_tool_path_text(raw)
    decoded = _try_unquote(text)
    if decoded != text:
        alt = normalize_user_path(decoded, workspace)
        if _exists(alt):
            return alt
    hit = _case_match(primary.parent, primary.name)
    if hit is not None:
        return hit
    return primary


def nearby_file_names(path: Path, *, limit: int = 8) -> list[str]:
    parent = path.parent
    try:
        if not parent.is_dir():
            return []
        names = sorted(
            (child.name for child in parent.iterdir() if child.is_file()),
            key=lambda n: n.lower(),
        )
    except OSError:
        return []
    stem = path.stem.lower()
    ranked = [n for n in names if Path(n).stem.lower() == stem] + [
        n for n in names if stem and stem in n.lower()
    ]
    seen: set[str] = set()
    out: list[str] = []
    for name in ranked + names:
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= limit:
            break
    return out


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
