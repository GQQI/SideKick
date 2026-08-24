"""Heuristics for agent shell commands: long-running, interactive, denylist."""

from __future__ import annotations

import re

_LONG_RUNNING_RE = re.compile(
    r"("
    r"npm\s+run\s+(dev|start|serve)|"
    r"yarn\s+(dev|start)|"
    r"pnpm\s+(dev|start)|"
    r"\bvite\b|"
    r"webpack-dev-server|"
    r"next\s+dev|"
    r"uvicorn\b.*(--reload|\breload\b)|"
    r"flask\s+run|"
    r"django(-admin)?\s+runserver|"
    r"python\s+-m\s+http\.server|"
    r"npx\s+serve|"
    r"nodemon\b|"
    r"tail\s+-f|"
    r"--watch\b"
    r")",
    re.I,
)


def is_long_running_command(command: str) -> bool:
    return bool(_LONG_RUNNING_RE.search(command or ""))


_TAIL_FILTER_RE = re.compile(
    r"\s*\|\s*(?:"
    r"Select-Object\s+-Last\s+\d+"
    r"|select\s+-Last\s+\d+"
    r"|tail\s+(?:-n\s*)?\d+"
    r")\s*$",
    re.I,
)


def strip_output_tail_filter(command: str) -> tuple[str, bool]:
    """Drop `| Select-Object -Last N` / `tail` — they hide logs until the command exits."""
    cmd = (command or "").rstrip()
    new, n = _TAIL_FILTER_RE.subn("", cmd, count=1)
    return new.strip() or cmd, n > 0


_INTERACTIVE_SCAFFOLD_RE = re.compile(
    r"("
    r"npm\s+create\s+vue|"
    r"npm\s+init\s+vue|"
    r"yarn\s+create\s+vue|"
    r"pnpm\s+create\s+vue|"
    r"npm\s+create\s+vite|"
    r"yarn\s+create\s+vite|"
    r"pnpm\s+create\s+vite|"
    r"create-react-app\b|"
    r"npx\s+create-react-app\b|"
    r"ng\s+new\b|"
    r"vue\s+create\b|"
    r"npx\s+@vue/cli\b|"
    r"npm\s+create\s+next-app|"
    r"npx\s+create-next-app|"
    r"npm\s+create\s+svelte|"
    r"npm\s+create\s+astro"
    r")",
    re.I,
)


def looks_interactive_scaffold(command: str) -> bool:
    return bool(_INTERACTIVE_SCAFFOLD_RE.search(command or ""))


def has_noninteractive_flags(command: str) -> bool:
    low = (command or "").lower()
    markers = (
        "--default",
        "--template",
        "--typescript",
        "--ts",
        "--javascript",
        "--js",
        "--router",
        "--pinia",
        "--with-tests",
        "--eslint",
        "--yes",
        " -y",
        "--ci",
        "--use-npm",
        "--use-pnpm",
        "--use-yarn",
        "--tailwind",
        "--app",
        "--src-dir",
    )
    if any(m in low for m in markers):
        return True
    if re.search(r"\s--\s+--", command or ""):
        return True
    return False


_DANGEROUS_SHELL_RE = re.compile(
    r"("
    r"rm\s+-rf\s+/|"
    r"rm\s+-rf\s+~|"
    r"format\s+c:|"
    r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;|"
    r"del\s+/s\s+/q\s+c:|"
    r"rd\s+/s\s+/q\s+c:|"
    r"mkfs\.|"
    r"dd\s+if=.*of=/dev/|"
    r">\s*/dev/sd|"
    r"\bshutdown\b|"
    r"\breboot\b"
    r")",
    re.I,
)

# Remove-Item -Recurse of a drive/home/unix *root* only — not project folders.
_REMOVE_ITEM_ROOT_RE = re.compile(
    r"remove-item\b(?=.*-recurse).*(?:"
    r"['\"][a-z]:[\\/]*['\"]"
    r"|[a-z]:[\\/]*(?:\s|$)"
    r"|['\"]~['\"]|(?<=\s)~(?:\s|$)"
    r"|['\"]/[\\/]*['\"]|(?<=\s)/(?:\s|$)"
    r"|\$home(?:\s|$|['\"])"
    r"|\$env:userprofile(?:\s|$|['\"])"
    r")",
    re.I,
)


def is_dangerous_shell(command: str) -> bool:
    low = (command or "").lower()
    if _DANGEROUS_SHELL_RE.search(low):
        return True
    return bool(_REMOVE_ITEM_ROOT_RE.search(low))
