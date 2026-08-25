"""Path, shell-process, skill-file, and codebase-align helpers."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

from ...core.config import Settings
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
    if os.name == "nt":
        return "Windows / PowerShell"
    return "Unix / bash"


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
    return ["/bin/bash", "-lc", command]


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
    """Start a process and return after collecting early logs (does not wait for exit)."""
    popen_kwargs: dict[str, Any] = {
        "cwd": cwd,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        **_subprocess_text_kwargs(),
        "env": env or {**os.environ, "PYTHONIOENCODING": "utf-8"},
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        # Detach from parent session so Ctrl+C on the server doesn't kill child servers
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(_shell_argv(command), **popen_kwargs)
    chunks: list[str] = []
    done = threading.Event()

    def _reader() -> None:
        assert proc.stdout is not None
        try:
            while not done.is_set():
                line = proc.stdout.readline()
                if not line:
                    break
                chunks.append(line)
                if sum(len(c) for c in chunks) > 12_000:
                    break
        except Exception:
            pass

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    t.join(timeout=collect_secs)
    done.set()
    # Give reader a moment to finish current line
    t.join(timeout=0.3)

    still = proc.poll() is None
    preview = "".join(chunks)[-8000:] or "(no output yet)"
    if still:
        return (
            f"background=true pid={proc.pid} status=running\n"
            f"command={command!r}\n"
            f"Collected first ~{collect_secs:.0f}s of logs (process keeps running; "
            f"agent will NOT wait for it to exit).\n"
            f"--- log ---\n{preview}"
        )
    out = preview
    return f"background=true pid={proc.pid} status=exited code={proc.returncode}\n--- log ---\n{out}"


def _safe_path(workspace: Path, raw: str, *, write: bool = False) -> Path:
    """Resolve a path. Relative → workspace; absolute → host (read and write)."""
    from ...core.pathutil import resolve_path

    if isinstance(raw, dict):
        raw = raw.get("path") or raw.get("dir") or "."
    text = str(raw or ".").strip()
    if text.startswith("{") and "path" in text:
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and obj.get("path"):
                text = str(obj["path"])
        except Exception:
            pass
    text = text.strip().strip('"').strip("'") or "."
    p = Path(text).expanduser()
    ws = resolve_path(workspace)
    if not p.is_absolute():
        p = resolve_path(ws / p)
    else:
        p = resolve_path(p)
    return p


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
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.lower()).strip("-")
    if not safe:
        raise ValueError("invalid skill name")
    dest = settings.skills_dir / "learned" / safe
    dest.mkdir(parents=True, exist_ok=True)
    text = f"---\nname: {safe}\ndescription: {description[:80]}\n---\n\n{content.strip()}\n"
    path = dest / "SKILL.md"
    path.write_text(text, encoding="utf-8")
    return path


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
