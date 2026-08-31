"""Host OS / time / network snapshot for prompts and tools."""

from __future__ import annotations

import os
import platform
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional


_NET_TTL_SEC = 45.0
_NET_TIMEOUT_SEC = 1.2
# China-reachable first, then global. Port 53/443 only — no HTTP payload.
_NET_PROBES: tuple[tuple[str, int], ...] = (
    ("223.5.5.5", 53),
    ("1.1.1.1", 443),
    ("114.114.114.114", 53),
)

_lock = threading.Lock()
_online_cache: Optional[tuple[float, bool]] = None
_info_cache: Optional["HostInfo"] = None


@dataclass(frozen=True)
class HostInfo:
    os_family: str  # windows | linux | darwin | other
    os_name: str  # Windows / Linux / 麒麟 / macOS
    distro: str
    is_kylin: bool
    kernel: str
    shell: str
    timezone: str
    local_time: str
    online: bool

    @property
    def label(self) -> str:
        if self.is_kylin:
            pretty = self.distro or "麒麟 Linux"
            return f"{pretty} (Kylin / Linux)"
        if self.os_family == "windows":
            return f"{self.distro or self.os_name} (Windows)"
        if self.os_family == "darwin":
            return f"{self.distro or 'macOS'} (Darwin)"
        if self.os_family == "linux":
            return f"{self.distro or 'Linux'} (Linux)"
        return self.distro or self.os_name or platform.system() or "unknown"


def _bool_env(*names: str) -> Optional[bool]:
    for name in names:
        raw = (os.getenv(name) or "").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            return True
        if raw in ("0", "false", "no", "off"):
            return False
    return None


def _read_os_release(path: Path | None = None) -> dict[str, str]:
    target = path or Path("/etc/os-release")
    out: dict[str, str] = {}
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def parse_os_release(text: str) -> dict[str, str]:
    """Test helper: parse os-release body."""
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def _is_kylin_fields(fields: dict[str, str]) -> bool:
    blob = " ".join(
        str(fields.get(k) or "")
        for k in ("ID", "ID_LIKE", "NAME", "PRETTY_NAME", "VERSION", "VERSION_ID")
    ).lower()
    needles = ("kylin", "麒麟", "neokylin", "galaxykylin", "kylinos", "uos")
    if any(n in blob for n in needles):
        # UOS is related but not always 麒麟; only treat as Kylin when kylin/麒麟 present
        if "uos" in blob and "kylin" not in blob and "麒麟" not in blob:
            return False
        return True
    return False


def _unix_shell_bin() -> str:
    for cand in ("/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "/bin/sh"


def unix_shell_argv(command: str) -> list[str]:
    """POSIX shell argv. Prefers bash; falls back to sh (麒麟 / minimal Linux)."""
    sh = _unix_shell_bin()
    flag = "-lc" if "bash" in os.path.basename(sh) else "-c"
    return [sh, flag, command]


def _probe_online() -> bool:
    forced = _bool_env("META_OFFLINE", "SIDEKICK_OFFLINE")
    if forced is True:
        return False
    if _bool_env("META_ONLINE", "SIDEKICK_ONLINE") is True:
        return True
    for host, port in _NET_PROBES:
        try:
            with socket.create_connection((host, port), timeout=_NET_TIMEOUT_SEC):
                return True
        except OSError:
            continue
    return False


def network_available(*, force_refresh: bool = False) -> bool:
    """Cached reachability. META_OFFLINE=1 forces False."""
    global _online_cache
    now = time.monotonic()
    with _lock:
        if (
            not force_refresh
            and _online_cache is not None
            and (now - _online_cache[0]) < _NET_TTL_SEC
        ):
            return _online_cache[1]
    online = _probe_online()
    with _lock:
        _online_cache = (time.monotonic(), online)
    return online


def _os_snapshot() -> tuple[str, str, str, bool, str, str]:
    system = (platform.system() or "").strip()
    kernel = platform.release() or ""
    if os.name == "nt" or system.lower().startswith("win"):
        ver = platform.version() or ""
        distro = f"Windows {platform.release()}".strip()
        if ver:
            distro = f"{distro}".strip()
        return "windows", "Windows", distro, False, kernel, "PowerShell"
    if system.lower() == "darwin":
        return "darwin", "macOS", platform.mac_ver()[0] or "macOS", False, kernel, "bash"
    fields = _read_os_release()
    pretty = fields.get("PRETTY_NAME") or fields.get("NAME") or "Linux"
    kylin = _is_kylin_fields(fields) or Path("/etc/kylin-release").is_file()
    os_name = "麒麟" if kylin else "Linux"
    distro = pretty
    if kylin and "麒麟" not in pretty and "kylin" not in pretty.lower():
        distro = f"麒麟 / {pretty}"
    sh = _unix_shell_bin()
    shell = "bash" if "bash" in os.path.basename(sh) else "sh"
    return "linux", os_name, distro, kylin, kernel, shell


def get_host_info(*, force_refresh: bool = False) -> HostInfo:
    global _info_cache
    online = network_available(force_refresh=force_refresh)
    if _info_cache is not None and not force_refresh:
        if _info_cache.online == online:
            now = datetime.now().astimezone()
            return HostInfo(
                os_family=_info_cache.os_family,
                os_name=_info_cache.os_name,
                distro=_info_cache.distro,
                is_kylin=_info_cache.is_kylin,
                kernel=_info_cache.kernel,
                shell=_info_cache.shell,
                timezone=now.tzname() or now.strftime("%z") or "local",
                local_time=now.strftime("%Y-%m-%d %H:%M:%S %z"),
                online=online,
            )
    family, os_name, distro, is_kylin, kernel, shell = _os_snapshot()
    now = datetime.now().astimezone()
    info = HostInfo(
        os_family=family,
        os_name=os_name,
        distro=distro,
        is_kylin=is_kylin,
        kernel=kernel,
        shell=shell,
        timezone=now.tzname() or now.strftime("%z") or "local",
        local_time=now.strftime("%Y-%m-%d %H:%M:%S %z"),
        online=online,
    )
    _info_cache = info
    return info


def reset_hostinfo_cache() -> None:
    global _online_cache, _info_cache
    with _lock:
        _online_cache = None
        _info_cache = None


def host_prompt_block() -> str:
    """System-prompt section: OS, time, network, shell dialect."""
    info = get_host_info()
    net = (
        "ONLINE — public internet looks reachable."
        if info.online
        else (
            "OFFLINE — no public internet. Do NOT call web_search or "
            "browser_navigate for public sites. Do not retry them. "
            "Use search_text / read_file / list_dir on the local workspace."
        )
    )
    lines = [
        "## Host environment (CRITICAL)",
        f"OS: {info.label}. Kernel: {info.kernel or '?'}.",
        f"Local time: {info.local_time} ({info.timezone}).",
        f"Network: {net}",
    ]
    if info.os_family == "windows":
        lines.extend(
            [
                "Shell executor: PowerShell (`powershell.exe -NoProfile -NonInteractive`).",
                "- Write PowerShell-compatible commands — do NOT assume bash/zsh.",
                "- Commands already run inside PowerShell — pass the script body directly "
                "(e.g. `Test-Path .\\file.html`). Do NOT wrap with `powershell -Command ...`.",
                "- Create dirs: `New-Item -ItemType Directory -Force -Path path` or `mkdir path` "
                "(no bash `mkdir -p`).",
                "- Download/HTTP: `curl.exe ...` or `Invoke-WebRequest` / `iwr` "
                "(prefer `curl.exe` when you need curl flags).",
                "- Chain with `;` or separate tool calls — avoid bash `&&` / `|` pipelines "
                "that rely on Unix tools.",
                "- Paths: prefer workspace-relative paths with forward slashes. "
                "Do NOT reuse another machine's drive letter (e.g. E:/Project/...). "
                "Absolute paths only if they exist on THIS host.",
            ]
        )
    else:
        sh = _unix_shell_bin()
        family = "麒麟 / Linux" if info.is_kylin else info.os_name
        lines.extend(
            [
                f"Shell executor: `{sh}` ({info.shell}). Host family: {family}.",
                "- Prefer portable POSIX commands (`mkdir -p`, `ls`, `curl`, `python3`).",
                "- Do NOT use PowerShell cmdlets or Windows drive letters (E:/ C:\\).",
                "- Paths: workspace-relative or POSIX absolute that exist on THIS machine.",
                "- Local preview URLs: bind IPv4 (`127.0.0.1`).",
            ]
        )
        if info.is_kylin:
            lines.append(
                "- 麒麟: treat as Linux. bash if present, otherwise sh. "
                "Use the distro's own package manager; do not assume apt/yum blindly."
            )
    lines.extend(
        [
            "- browser_navigate is for http(s) or a workspace-relative HTML file. "
            "Never pass file://.",
            "- Do NOT open Edge/Chrome via shell for local previews. Tell the user the URL.",
            "- If run_shell/verify_run returns shell-disabled, tell the user to set "
            "META_ALLOW_SHELL=1 and restart — do NOT invent OS-specific unavailability.",
        ]
    )
    return "\n".join(lines)
