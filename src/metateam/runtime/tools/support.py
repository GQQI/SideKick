"""Path, shell-process, skill-file, and codebase-align helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from ...core.config import Settings
from ...core.hostinfo import get_host_info, unix_shell_argv
from ...core.pathutil import normalize_user_path
from ...services.skills import Skill
from ..shell_policy import (
    is_dangerous_shell as _is_dangerous_shell,
)
from ..tool_registry import Tool, skill_tool_name

def _subprocess_text_kwargs() -> dict[str, Any]:
    """Always decode child output as UTF-8 with replacement — never locale GBK."""
    return {
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }


def _shell_host_label() -> str:
    """Short OS + shell dialect for prompts / tool descriptions."""
    info = get_host_info()
    if info.os_family == "windows":
        return "Windows / PowerShell"
    if info.is_kylin:
        return f"麒麟 / {info.shell}"
    if info.os_family == "linux":
        return f"Linux / {info.shell}"
    if info.os_family == "darwin":
        return "macOS / bash"
    return f"{info.os_name} / {info.shell}"


def _shell_argv(command: str) -> list[str]:
    """Run via explicit shell binary — avoids Python shell=True string risks."""
    if os.name == "nt":
        # PowerShell so mkdir/curl aliases and modern Windows tooling work as expected.
        # Force UTF-8 console output so child stdout isn't OEM/GBK (avoids decode crashes).
        ps = (
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "$OutputEncoding = [Console]::OutputEncoding; "
            f"{command}"
        )
        return [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ps,
        ]
    return unix_shell_argv(command)


def _shell_policy(settings: Settings, workspace: Path):
    from ...services.shell_sandbox import ShellSandboxPolicy

    return ShellSandboxPolicy.for_workspace(
        workspace,
        enabled=bool(getattr(settings, "shell_sandbox", True)),
    )


def _guard_shell(command: str, *, settings: Settings, workspace: Path) -> Optional[str]:
    from ...services.shell_sandbox import check_command

    return check_command(
        command,
        cwd=workspace,
        policy=_shell_policy(settings, workspace),
    )


def _sandboxed_env(settings: Settings) -> dict[str, str]:
    from ...services.shell_sandbox import sandbox_env

    return sandbox_env()


def _run_shell_background(command: str, *, cwd: str, collect_secs: float = 8.0, env: Optional[dict[str, str]] = None) -> str:
    """Start a tracked job and return after collecting early logs (does not wait for exit)."""
    from ...services.shell_jobs import JOBS, format_job_result

    job = JOBS.start(command, cwd=cwd, env=env, background=True)
    JOBS.wait(job.id, max(0.4, float(collect_secs or 0)))
    if job.alive():
        JOBS.mark_released(job)
    return format_job_result(
        job,
        background=True,
        note=f"Collected first ~{collect_secs:.0f}s of logs; the job keeps running.",
    )


def _safe_path(workspace: Path, raw: str, *, write: bool = False) -> Path:
    """Resolve a path. Relative → workspace; local absolute → host.

    Foreign drive-letter paths (copied from another PC, or Windows paths on
    Linux/麒麟) are remapped into the workspace so write_file keeps working.
    """
    if isinstance(raw, dict):
        raw = (
            raw.get("path")
            or raw.get("file_path")
            or raw.get("filepath")
            or raw.get("filename")
            or raw.get("dir")
            or "."
        )
    text = str(raw or ".").strip()
    if text.startswith("{") and "path" in text:
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                text = str(
                    obj.get("path")
                    or obj.get("file_path")
                    or obj.get("filepath")
                    or obj.get("filename")
                    or text
                )
        except Exception:
            pass
    text = text.strip() or "."
    return normalize_user_path(text, workspace)


def _skill_as_tool(skill: Skill) -> Tool:
    """Expose a SKILL.md as a callable function tool."""

    tname = skill_tool_name(skill.name)
    desc = (skill.description or f"Apply the '{skill.name}' skill procedure.").strip()
    if len(desc) > 400:
        desc = desc[:397] + "..."

    def handler(task: str = "") -> str:
        header = f"# Function skill: {skill.name}\n"
        if task.strip():
            header += f"Requested task: {task.strip()}\n\n"
        header += (
            "Follow the procedure below with other tools (read_file/write_file/…). "
            "Do not stop after reading — execute the steps.\n\n"
        )
        return header + skill.read_body()

    return Tool(
        name=tname,
        description=desc,
        parameters={
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Optional: what you want this skill to accomplish now.",
                }
            },
            "required": [],
        },
        handler=handler,
        parallel_safe=True,
    )


def save_skill_file(settings: Settings, name: str, description: str, content: str) -> Path:
    from ...services.skills import write_skill

    sk = write_skill(
        settings.skills_dir,
        name=name,
        description=description,
        content=content,
        overwrite=True,
    )
    return sk.path


# back-compat alias for review.py
_save_skill_file = save_skill_file


def _looks_like_code_path(path: str) -> bool:
    suffix = Path(path).suffix.lower()
    if not suffix:
        return False
    from ...services.codebase_memory import CODE_SUFFIXES

    return suffix in CODE_SUFFIXES


# Content / config deliverables — creating these should not require a prior
# codebase_find_similar (align is for reusable code modules, not decks/docs).
_ALIGN_EXEMPT_SUFFIXES = {
    ".html",
    ".htm",
    ".md",
    ".txt",
    ".css",
    ".scss",
    ".less",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".svg",
}


def _needs_codebase_align(path: str, workspace: Path) -> bool:
    """True when creating this new file should require a prior similarity align."""
    suffix = Path(path).suffix.lower()
    if not suffix or suffix in _ALIGN_EXEMPT_SUFFIXES:
        return False
    if not _looks_like_code_path(path):
        return False
    # Greenfield workspace: nothing to reuse yet.
    try:
        from ...services import codebase_memory as cbm

        idx = cbm.get_or_build_index(workspace)
        if idx.file_count() == 0:
            return False
    except Exception:
        pass
    return True
