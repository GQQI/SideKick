"""run_shell and verify_run."""

from __future__ import annotations

import os
import subprocess

from ..shell_policy import (
    has_noninteractive_flags as _has_noninteractive_flags,
    is_dangerous_shell as _is_dangerous_shell,
    is_long_running_command as _is_long_running_command,
    looks_interactive_scaffold as _looks_interactive_scaffold,
    strip_output_tail_filter as _strip_output_tail_filter,
)
from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext
from .support import (
    _guard_shell,
    _run_shell_background,
    _sandboxed_env,
    _shell_argv,
    _shell_host_label,
    _subprocess_text_kwargs,
)


def register_shell_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    settings = ctx.settings
    live_ws = ctx.live_ws

    def verify_run(command: str, timeout_sec: int = 120) -> str:
        """Run a verification command (tests/lint). Requires approval; needs shell enabled."""
        if not settings.allow_shell:
            return (
                "ERROR: shell disabled (META_ALLOW_SHELL=0). "
                "Enable shell to run verify_run, or tell the user the verify command to run locally."
            )
        cmd = (command or "").strip()
        if not cmd:
            return "ERROR: empty command"
        if _is_dangerous_shell(cmd):
            return "ERROR: command blocked by safety denylist"
        blocked = _guard_shell(cmd, settings=settings, workspace=live_ws())
        if blocked:
            return blocked
        if _is_long_running_command(cmd):
            return "ERROR: verify_run is for one-shot checks, not long-running servers"
        timeout = max(15, min(int(timeout_sec or 120), 600))
        try:
            proc = subprocess.run(
                _shell_argv(cmd),
                cwd=str(live_ws().resolve()),
                capture_output=True,
                **_subprocess_text_kwargs(),
                timeout=timeout,
                shell=False,
                env=_sandboxed_env(settings),
            )
        except subprocess.TimeoutExpired:
            return f"VERIFY FAIL timeout={timeout}s command={cmd!r}"
        except Exception as exc:  # noqa: BLE001
            return f"VERIFY FAIL error={exc}"
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if len(out) > 12_000:
            out = out[:12_000] + "\n…[truncated]"
        status = "PASS" if proc.returncode == 0 else "FAIL"
        return f"VERIFY {status} exit={proc.returncode}\ncommand={cmd!r}\n---\n{out or '(no output)'}"

    def run_shell(
        command: str,
        background: bool = False,
        stdin_text: str = "",
        timeout_sec: int = 0,
    ) -> str:
        if not settings.allow_shell:
            return "ERROR: shell disabled (set META_ALLOW_SHELL=1 to enable)"
        command, _stripped_tail = _strip_output_tail_filter(command)
        low = command.lower().strip()
        if _is_dangerous_shell(command):
            return (
                "ERROR: blocked dangerous command "
                "(recursive delete of a drive or home root is not allowed). "
                "To delete a project folder, use a relative path such as "
                "Remove-Item -Path .\\login-page -Recurse -Force"
            )
        blocked = _guard_shell(command, settings=settings, workspace=live_ws())
        if blocked:
            return blocked

        # Interactive scaffolding CLIs hang with no TTY — steer to non-interactive.
        if _looks_interactive_scaffold(low) and not _has_noninteractive_flags(low):
            return (
                "ERROR: this command looks like an interactive scaffold CLI "
                "(create-vue / create-react-app / angular / etc.). "
                "Sidekick has no TTY for arrow-key menus.\n"
                "Use non-interactive flags instead, for example:\n"
                "  npm create vue@latest my-app -- --default\n"
                "  npm create vue@latest my-app -- --typescript --router --pinia --eslint-with-prettier\n"
                "  npm create vite@latest my-app -- --template vue\n"
                "Or call ask_user to pick options, then re-run with those flags. "
                "Optional: pass stdin_text with newline-separated answers for simple prompts."
            )

        env = _sandboxed_env(settings)
        # Dev servers / watchers never exit — must not block the agent.
        long_running = background or _is_long_running_command(low)
        if long_running:
            return _run_shell_background(
                command, cwd=str(live_ws().resolve()), collect_secs=8.0, env=env
            )

        # Optional per-call timeout (models often pass this; default = settings.shell_timeout).
        try:
            want = int(timeout_sec or 0)
        except (TypeError, ValueError):
            want = 0
        timeout = max(15, min(want, 600)) if want > 0 else int(settings.shell_timeout)

        input_data = stdin_text if stdin_text else None
        try:
            proc = subprocess.run(
                _shell_argv(command),
                cwd=str(live_ws().resolve()),
                capture_output=True,
                input=input_data,
                **_subprocess_text_kwargs(),
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            partial = (exc.stdout or "") + (("\n" + (exc.stderr or "")) if exc.stderr else "")
            partial = partial[-8000:]
            hint = ""
            if _looks_interactive_scaffold(low) or "select" in partial.lower() or "?" in partial:
                hint = (
                    "\nHint: if the CLI is waiting for interactive choices, stop and re-run "
                    "with non-interactive flags (e.g. `npm create vue@latest app -- --default`) "
                    "or ask_user then pass flags / stdin_text."
                )
            return (
                f"ERROR: timeout after {timeout}s — command still running or hung.\n"
                f"For servers (npm run dev / vite / uvicorn), call run_shell with background=true.\n"
                f"partial_output:\n{partial or '(none)'}"
                f"{hint}"
            )
        except UnicodeDecodeError as exc:
            # Should be unreachable with errors=replace; keep a clear fallback.
            return f"ERROR: shell output decode failed ({exc}); retry with ASCII-only commands"
        out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        if len(out) > 14_000:
            out = out[:14_000] + "\n…[truncated]"
        return f"exit={proc.returncode}\n{out}"

    reg.register(
        Tool(
            "verify_run",
            "Run a one-shot verification command (tests/lint). Requires approval and META_ALLOW_SHELL=1. "
            "Prefer this over open-ended shell for acceptance checks. "
            "If shape_contract.verify_command is set, run that before claiming done. "
            f"Host shell: {_shell_host_label()} — write the command for that dialect.",
            {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout_sec": {"type": "integer", "default": 120},
                },
                "required": ["command"],
            },
            verify_run,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    if settings.allow_shell:
        _shell_desc = (
            "Run a shell command in the workspace. Prefer read_file for reading files. "
            f"Host shell: {_shell_host_label()}. "
            "IMPORTANT: long-running servers (npm run dev, vite, uvicorn --reload, etc.) "
            "are auto-started in background and return early with pid + startup logs — "
            "do NOT wait for them to exit. Set background=true to force background mode. "
            "Scaffold CLIs (create-vue / create-vite / create-next-app) have NO TTY — "
            "always use non-interactive flags, e.g. "
            "`npm create vue@latest my-app -- --default` or "
            "`npm create vite@latest my-app -- --template vue`. "
            "Call ask_user first if the user must pick TypeScript/Router/etc., then encode as flags. "
            "Optional stdin_text pipes line-based answers (prefer flags)."
        )
        if os.name == "nt":
            _shell_desc += (
                " On Windows use PowerShell syntax (not bash): mkdir path; "
                "New-Item -ItemType Directory -Force; curl.exe or Invoke-WebRequest; "
                "use ';' or separate calls instead of bash '&&' / 'mkdir -p'."
            )
        else:
            _shell_desc += (
                " On Linux / 麒麟 use POSIX/bash (mkdir -p, curl, python3). "
                "Do not use PowerShell or Windows drive letters."
            )
        reg.register(
            Tool(
                "run_shell",
                _shell_desc,
                {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "background": {
                            "type": "boolean",
                            "description": "If true, start and return without waiting for exit.",
                        },
                        "stdin_text": {
                            "type": "string",
                            "description": (
                                "Optional stdin for simple prompts (newline-separated). "
                                "Prefer non-interactive CLI flags for scaffolds."
                            ),
                        },
                        "timeout_sec": {
                            "type": "integer",
                            "description": (
                                "Optional timeout in seconds for foreground commands "
                                f"(default {settings.shell_timeout}, max 600). Ignored when background=true."
                            ),
                        },
                    },
                    "required": ["command"],
                },
                run_shell,
                parallel_safe=False,
                requires_approval=True,
            )
        )
