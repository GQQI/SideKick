"""Serve workspace HTML over loopback http so the sandbox opens a real link.

browser_navigate is for http(s) URLs. Local file:// paths are converted to
http://127.0.0.1:<port>/relative.html (workspace-rooted static server).
"""

from __future__ import annotations

import os
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

from ..core.pathutil import is_relative_to, relative_to_posix, resolve_path

_PREVIEW_SUFFIXES = {".html", ".htm", ".pdf"}
_FILE_DRIVE_RE = re.compile(r"^/[A-Za-z]:")

_lock = threading.Lock()
_httpd: Optional[ThreadingHTTPServer] = None
_root: Optional[Path] = None
_port: int = 0


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


def _path_from_file_url(url: str) -> Optional[Path]:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return None
    if parsed.scheme.lower() != "file":
        return None
    path = unquote(parsed.path or "")
    if os.name == "nt":
        if parsed.netloc and parsed.netloc.lower() not in ("", "localhost", "127.0.0.1"):
            return Path("\\\\" + parsed.netloc + path.replace("/", "\\"))
        if _FILE_DRIVE_RE.match(path):
            path = path[1:]
        path = path.replace("/", "\\")
    return Path(path) if path else None


def resolve_local_html_file(raw: str, *, workspace: Optional[Path]) -> Optional[Path]:
    """Return an existing .html/.htm/.pdf path inside workspace, or None."""
    text = (raw or "").strip().strip("'\"")
    if not text or text.lower() in {"about:blank", "http://", "https://"}:
        return None
    if text.lower().startswith("file:"):
        cand = _path_from_file_url(text)
    else:
        p = Path(text)
        if p.is_absolute():
            cand = p
        elif workspace is not None:
            cand = workspace / text
        else:
            cand = p
    if cand is None:
        return None
    try:
        cand = resolve_path(cand)
    except OSError:
        return None
    if cand.suffix.lower() not in _PREVIEW_SUFFIXES:
        return None
    if not cand.is_file():
        return None
    if workspace is not None and not is_relative_to(cand, workspace):
        return None
    return cand


def ensure_preview_server(root: Path) -> int:
    """Start (or reuse) a loopback static server for this workspace root."""
    global _httpd, _root, _port
    root = resolve_path(root)
    with _lock:
        if _httpd is not None and _root == root and _port:
            return _port
        if _httpd is not None:
            try:
                _httpd.shutdown()
            except Exception:
                pass
            _httpd = None
        handler = partial(_QuietHandler, directory=str(root))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = int(httpd.server_address[1])
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        _httpd = httpd
        _root = root
        _port = port
        return port


def is_preview_http_url(url: str) -> bool:
    """True if this is the loopback static server for workspace HTML/PDF."""
    text = (url or "").strip()
    with _lock:
        port = int(_port or 0)
    if not text or port <= 0:
        return False
    try:
        parsed = urlparse(text)
    except Exception:
        return False
    if (parsed.scheme or "").lower() != "http":
        return False
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost"}:
        return False
    try:
        return int(parsed.port or 0) == port
    except ValueError:
        return False


def preview_http_url(html_file: Path, workspace: Path) -> str:
    port = ensure_preview_server(workspace)
    rel = relative_to_posix(html_file, workspace)
    if rel in {".", ""}:
        rel = html_file.name
    return f"http://127.0.0.1:{port}/{rel.lstrip('/')}"
