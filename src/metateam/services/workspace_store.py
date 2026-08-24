"""Workspace directory selection — any local absolute folder path."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from ..core.config import REPO_ROOT, ROOT, get_settings
from .tenant_context import DEFAULT_USER_ID, get_user_id, tenant_workspace_path

MAX_RECENT = 12


def _legacy_state_candidates(uid: str) -> list[Path]:
    """Older layouts that may still hold a saved workspace path.

    Only the default / pre-login context may read these global orphans so a
    logged-in tenant never accidentally picks up another user's folder.
    """
    if uid != DEFAULT_USER_ID:
        return []
    return [
        ROOT / "data" / "workspace.json",
        REPO_ROOT / "backend" / "data" / "workspace.json",
    ]


def _state_path() -> Path:
    """Preferred path for the current user's workspace.json (may not exist yet)."""
    return tenant_workspace_path(get_user_id())


def _resolve_state_file() -> Optional[Path]:
    """Existing state file for the current user, including legacy fallbacks."""
    uid = get_user_id()
    primary = tenant_workspace_path(uid)
    if primary.exists():
        return primary
    for legacy in _legacy_state_candidates(uid):
        if legacy.exists():
            return legacy
    return None


# Back-compat
STATE_PATH = ROOT / "data" / "workspace.json"


def _read_state() -> dict[str, Any]:
    path = _resolve_state_file()
    if not path:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_state(path: Path, recent: list[str] | None = None) -> None:
    # Always persist into the authenticated tenant bucket (not legacy globals).
    state_path = tenant_workspace_path(get_user_id())
    state_path.parent.mkdir(parents=True, exist_ok=True)
    prev = _read_state()
    items = recent if recent is not None else list(prev.get("recent") or [])
    resolved = str(path.resolve())
    items = [resolved, *[p for p in items if p != resolved]]
    items = items[:MAX_RECENT]
    state_path.write_text(
        json.dumps({"path": resolved, "recent": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def is_configured() -> bool:
    data = _read_state()
    raw = str(data.get("path") or "").strip()
    if not raw:
        return False
    try:
        return Path(raw).expanduser().resolve().is_dir()
    except Exception:
        return False


def list_workspaces() -> list[dict[str, Any]]:
    """Recent workspace folders (absolute paths on this machine)."""
    data = _read_state()
    recent = list(data.get("recent") or [])
    active = str(data.get("path") or "").strip()
    if active and active not in recent:
        recent = [active, *recent]

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in recent:
        try:
            p = Path(str(raw)).expanduser().resolve()
        except Exception:
            continue
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        if not p.is_dir():
            continue
        items.append(
            {
                "id": key,
                "name": p.name or key,
                "path": key,
                "is_default": False,
            }
        )
    return items[:MAX_RECENT]


def get_active_workspace() -> dict[str, Any]:
    """Return the saved workspace for the current user (disk is source of truth)."""
    # Keep live Settings in sync whenever an authenticated request asks.
    apply_saved_workspace()
    data = _read_state()
    raw = str(data.get("path") or "").strip()
    if not raw:
        return {"path": "", "name": "", "configured": False}
    try:
        path = Path(raw).expanduser().resolve()
        if not path.is_dir():
            return {"path": "", "name": "", "configured": False}
    except Exception:
        return {"path": "", "name": "", "configured": False}
    return {"path": str(path), "name": path.name or str(path), "configured": True}


def set_workspace(path_or_name: str, *, create: bool = False) -> dict[str, Any]:
    """Set active workspace to an absolute folder on this machine."""
    raw = path_or_name.strip().strip('"').strip("'")
    if not raw:
        raise ValueError("请填写本机文件夹的绝对路径")

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ValueError("请使用绝对路径，例如 D:\\Projects\\my-app 或 /home/user/proj")

    candidate = candidate.resolve()
    if not candidate.exists():
        if create:
            candidate.mkdir(parents=True, exist_ok=True)
        else:
            raise ValueError(f"路径不存在：{candidate}")
    if not candidate.is_dir():
        raise ValueError(f"不是文件夹：{candidate}")

    _write_state(candidate)

    s = get_settings()
    s.workspace = candidate
    try:
        from .model_config import apply_to_settings, load_model_config

        apply_to_settings(s, load_model_config())
    except Exception:
        pass
    return {
        "path": str(candidate),
        "name": candidate.name or str(candidate),
        "configured": True,
    }


def create_workspace(path: str) -> dict[str, Any]:
    """Create folder (if needed) and switch to it. `path` must be absolute."""
    return set_workspace(path, create=True)


def apply_saved_workspace(settings: Any | None = None) -> bool:
    """Load the current user's saved workspace into ``settings``.

    Returns True when ``settings.workspace`` changed. Safe to call after
    ``set_user`` on each request — startup has no tenant context, so the
    real path must be re-applied once the user is known.
    """
    data = _read_state()
    raw = str(data.get("path") or "").strip()
    if not raw:
        return False
    try:
        path = Path(raw).expanduser().resolve()
        if not path.is_dir():
            return False
    except Exception:
        return False

    s = settings if settings is not None else get_settings()
    try:
        current = Path(s.workspace).expanduser().resolve()
    except Exception:
        current = None
    if current == path:
        return False

    s.workspace = path
    # If we loaded from a legacy global file, copy into the tenant bucket once.
    tenant_path = tenant_workspace_path(get_user_id())
    if not tenant_path.exists():
        try:
            _write_state(path, recent=list(data.get("recent") or []))
        except Exception:
            pass
    return True
