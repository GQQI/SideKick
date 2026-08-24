"""Tool registry + builtins (files, shell, skills, memory, delegate)."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Optional

from ..core.config import Settings
from ..services.skills import Skill, load_skills
from .ask import normalize_option_labels
from .shell_policy import (
    has_noninteractive_flags as _has_noninteractive_flags,
    is_dangerous_shell as _is_dangerous_shell,
    is_long_running_command as _is_long_running_command,
    looks_interactive_scaffold as _looks_interactive_scaffold,
    strip_output_tail_filter as _strip_output_tail_filter,
)
from .tool_registry import Tool, ToolRegistry, plan_parallel_batches, skill_tool_name

# agent.py / prompts.py keep `from .tools import …` after the extract.
__all__ = [
    "Tool",
    "ToolRegistry",
    "build_registry",
    "plan_parallel_batches",
    "skill_tool_name",
    "save_skill_file",
]


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
    from ..services.shell_sandbox import ShellSandboxPolicy

    return ShellSandboxPolicy.for_workspace(
        workspace,
        enabled=bool(getattr(settings, "shell_sandbox", True)),
    )


def _guard_shell(command: str, *, settings: Settings, workspace: Path) -> Optional[str]:
    from ..services.shell_sandbox import check_command

    return check_command(
        command,
        cwd=workspace,
        policy=_shell_policy(settings, workspace),
    )


def _sandboxed_env(settings: Settings) -> dict[str, str]:
    from ..services.shell_sandbox import sandbox_env

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
    from ..core.pathutil import resolve_path

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
    from ..services.codebase_memory import CODE_SUFFIXES

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
        from ..services import codebase_memory as cbm

        idx = cbm.get_or_build_index(workspace)
        if idx.file_count() == 0:
            return False
    except Exception:
        pass
    return True


def build_registry(
    settings: Settings,
    *,
    skills: list[Skill],
    allow_delegate: bool = True,
    run_child: Optional[Callable[..., str]] = None,
    ask_user_fn: Optional[Callable[..., str]] = None,
) -> ToolRegistry:
    reg = ToolRegistry()

    def live_ws() -> Path:
        """Do not cache Path — user may switch the workspace after the session started."""
        return Path(settings.workspace)

    # Codebase-as-Memory: new code files require a prior similarity align in this run.
    align_state: dict[str, Any] = {"aligned": False, "queries": []}

    def read_file(path: str, offset: int = 1, limit: int = 0) -> str:
        """Read a text file. limit<=0 means read through end of file (no hard cap)."""
        fp = _safe_path(live_ws(), path)
        if not fp.exists():
            return f"ERROR: not found: {fp}"
        lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()
        offset = max(1, int(offset))
        total = len(lines)
        req_limit = int(limit)
        # Default / non-positive limit → remainder of file (no artificial ceiling).
        if req_limit <= 0:
            req_limit = max(0, total - (offset - 1))
        chunk = lines[offset - 1 : offset - 1 + req_limit]
        body = "\n".join(f"{i}|{line}" for i, line in enumerate(chunk, start=offset))
        if offset - 1 + req_limit < total:
            body += f"\n… next_offset={offset + req_limit} total_lines={total}"
        return body

    def write_file(path: str, content: str, force_create: bool = False) -> str:
        from ..services import fs_api
        from ..services import codebase_memory as cbm

        try:
            target = _safe_path(live_ws(), path)
            try:
                from ..core.pathutil import is_relative_to, relative_to_posix

                rel = relative_to_posix(target, live_ws()) if is_relative_to(target, live_ws()) else str(target)
            except Exception:
                rel = str(target)
            is_new = not target.exists()
            align_note = ""
            if (
                is_new
                and _needs_codebase_align(rel, live_ws())
                and not bool(force_create)
                and not align_state["aligned"]
            ):
                # Auto-align instead of hard-failing — models often skip codebase_find_similar.
                q = f"{Path(rel).stem} {Path(rel).suffix} {(content or '')[:240]}".strip()
                try:
                    index = cbm.get_or_build_index(live_ws())
                    hits = cbm.find_similar(index, q, limit=8)
                    align_state["aligned"] = True
                    align_state["queries"].append(q)
                    if hits:
                        paths: list[str] = []
                        for h in hits[:5]:
                            if isinstance(h, dict):
                                paths.append(str(h.get("path") or h.get("file") or h)[:80])
                            else:
                                paths.append(str(h)[:80])
                        align_note = (
                            "\nnote: similar existing files (prefer reuse next time): "
                            + ", ".join(paths)
                        )
                except Exception:
                    align_state["aligned"] = True

            res = fs_api.write_text(rel, content, allow_outside=True)
            cbm.invalidate_index(live_ws())
            return f"wrote {res['path']} ({res['size']} chars){align_note}"
        except Exception as exc:
            return f"ERROR: {exc}"

    def str_replace(
        path: str,
        old_string: str = "",
        new_string: str = "",
        replace_all: bool = False,
    ) -> str:
        from ..core.pathutil import is_relative_to, relative_to_posix
        from ..services import codebase_memory as cbm
        from ..services import fs_api
        from ..services.file_edit import apply_str_replace

        try:
            target = _safe_path(live_ws(), path)
            if not target.exists() or not target.is_file():
                return f"ERROR: not found: {target}"
            try:
                text = target.read_text(encoding="utf-8")
            except OSError as exc:
                return f"ERROR: {exc}"
            try:
                updated, n = apply_str_replace(
                    text, old_string, new_string, replace_all=bool(replace_all)
                )
            except ValueError as exc:
                return f"ERROR: {exc}"
            try:
                rel = (
                    relative_to_posix(target, live_ws())
                    if is_relative_to(target, live_ws())
                    else str(target)
                )
            except Exception:
                rel = str(target)
            res = fs_api.write_text(rel, updated, allow_outside=True)
            cbm.invalidate_index(live_ws())
            return f"updated {res['path']} ({n} replacement{'s' if n != 1 else ''})"
        except Exception as exc:
            return f"ERROR: {exc}"

    def delete_file(path: str) -> str:
        from ..services import fs_api
        from ..services import codebase_memory as cbm

        try:
            rel = path.replace("\\", "/")
            try:
                if Path(path).is_absolute():
                    from ..core.pathutil import relative_to_posix

                    rel = relative_to_posix(path, live_ws())
            except Exception:
                pass
            res = fs_api.delete_entry(rel, recursive=False)
            cbm.invalidate_index(live_ws())
            return f"deleted {res['path']}"
        except Exception as exc:
            return f"ERROR: {exc}"

    def codebase_overview(refresh: bool = False) -> str:
        from ..services import codebase_memory as cbm

        index = cbm.get_or_build_index(live_ws(), force=bool(refresh))
        ov = cbm.overview(index)
        return json.dumps(ov, ensure_ascii=False, indent=2)

    def codebase_find_similar(query: str, limit: int = 12) -> str:
        from ..services import codebase_memory as cbm

        q = (query or "").strip()
        if not q:
            return "ERROR: empty query"
        index = cbm.get_or_build_index(live_ws())
        hits = cbm.find_similar(index, q, limit=max(1, min(int(limit), 30)))
        align_state["aligned"] = True
        align_state["queries"].append(q)
        payload = {
            "query": q,
            "aligned": True,
            "match_count": len(hits),
            "matches": hits,
            "guidance": (
                "If matches exist, prefer extending/reusing them over creating a parallel file. "
                "If match_count is 0, you may write_file with force_create=true."
            ),
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def codebase_impact(symbol_or_path: str, limit: int = 40) -> str:
        from ..services import codebase_memory as cbm

        needle = (symbol_or_path or "").strip()
        if not needle:
            return "ERROR: empty symbol_or_path"
        index = cbm.get_or_build_index(live_ws())
        refs = cbm.find_references(live_ws(), index, needle, limit=max(1, min(int(limit), 80)))
        payload = {
            "target": needle,
            "reference_files": len(refs),
            "hits": refs,
            "guidance": "Treat listed files as blast radius; avoid breaking callers.",
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def coherence_checklist() -> str:
        from .coherence import PILE_CHECKLIST

        return (
            PILE_CHECKLIST
            + "\n\nReply against each item with evidence (paths). "
            "If any fail, fix by extending existing assets before you stop."
        )

    def git_status() -> str:
        from ..services import git_ops

        return git_ops.git_status(live_ws())

    def git_diff(staged: bool = False, path: str = "") -> str:
        from ..services import git_ops

        return git_ops.git_diff(live_ws(), staged=bool(staged), path=(path or "").strip())

    def git_log(limit: int = 12) -> str:
        from ..services import git_ops

        return git_ops.git_log(live_ws(), limit=limit)

    def git_branch() -> str:
        from ..services import git_ops

        return git_ops.git_branch(live_ws())

    def git_commit(message: str) -> str:
        from ..services import git_ops

        return git_ops.git_commit(live_ws(), message)

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

    def list_dir(path: str = ".") -> str:
        try:
            fp = _safe_path(live_ws(), path)
            if not fp.exists():
                return f"ERROR: not found: {fp}"
            if fp.is_file():
                return f"FILE {fp}"
            entries = sorted(fp.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            lines = [f"# {fp}"]
            for e in entries[:240]:
                lines.append(f"{'dir' if e.is_dir() else 'file'}\t{e.name}")
            if len(entries) > 240:
                lines.append(f"… {len(entries) - 240} more")
            return "\n".join(lines) or "(empty)"
        except OSError as exc:
            return f"ERROR: list_dir failed: {exc}"

    def search_text(
        query: str,
        path: str = ".",
        glob: str = "*",
        regex: bool = False,
    ) -> str:
        from ..services.repo_search import search_text as repo_search_text

        try:
            base = _safe_path(live_ws(), path)
        except OSError as exc:
            return f"ERROR: {exc}"
        return repo_search_text(
            live_ws(),
            query,
            path=base,
            glob=glob,
            regex=bool(regex),
        )

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

    def skill_save(name: str, description: str, content: str) -> str:
        path = save_skill_file(settings, name, description, content)
        skills[:] = load_skills(settings.skills_dir)
        return f"saved skill_* function → {path} (reload session to refresh tools)"

    def memory_append(
        note: str,
        category: str = "",
        title: str = "",
        tags: str = "",
    ) -> str:
        from ..services.memory import append_memory

        return append_memory(
            settings.memory_file,
            note,
            category=category,
            title=title,
            tags=tags,
        )

    def memory_read(
        category: str = "",
        tags: str = "",
        memory_id: str = "",
    ) -> str:
        from ..services.memory import read_memory_detail

        return read_memory_detail(
            settings.memory_file,
            category=category,
            tags=tags,
            memory_id=memory_id,
            include_disabled=True,
            max_chars=8000,
        )

    def memory_list() -> str:
        from ..services.memory import list_library_text

        return list_library_text(settings.memory_file)

    def memory_remove(match: str = "", memory_id: str = "") -> str:
        from ..services.memory import remove_memory

        return remove_memory(settings.memory_file, match=match, memory_id=memory_id)

    def memory_write(
        content: str,
        memory_id: str = "",
        category: str = "",
        title: str = "",
        tags: str = "",
    ) -> str:
        from ..services.memory import replace_memory

        return replace_memory(
            settings.memory_file,
            content,
            memory_id=memory_id,
            category=category,
            title=title,
            tags=tags,
        )

    reg.register(
        Tool(
            "read_file",
            "Read a text file with line numbers. By default reads the whole file from offset "
            "(limit=0). Pass a positive limit only when you intentionally want a slice.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "offset": {"type": "integer", "default": 1},
                    "limit": {
                        "type": "integer",
                        "default": 0,
                        "description": "Lines to read; 0 or omit = through end of file.",
                    },
                },
                "required": ["path"],
            },
            read_file,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "write_file",
            "Create a new text file or fully rewrite one. Requires user approval. "
            "To change an existing file, prefer str_replace (unique old_string). "
            "For NEW code modules, Sidekick auto-checks similar existing files "
            "(prefer codebase_find_similar first when reusing is likely). "
            "force_create=true skips the similarity note path.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "force_create": {
                        "type": "boolean",
                        "description": (
                            "Optional. Skips auto similarity note when creating a new code file."
                        ),
                    },
                },
                "required": ["path", "content"],
            },
            write_file,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "str_replace",
            "Surgically edit an existing text file by replacing an exact substring. "
            "Requires user approval. old_string must match exactly once unless "
            "replace_all=true. Prefer this over write_file for existing files.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to find (include enough context to be unique).",
                    },
                    "new_string": {"type": "string", "description": "Replacement text."},
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence when old_string is not unique.",
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
            str_replace,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "delete_file",
            "Delete a file (or empty directory) under the workspace. Requires user approval.",
            {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            delete_file,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "list_dir",
            "List files in a directory. Relative paths resolve under WORKSPACE; "
            "absolute paths (e.g. E:/Project/anydoc) may be anywhere on the host.",
            {
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
                "required": [],
            },
            list_dir,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "search_text",
            "Ripgrep-style recursive search. Skips .git, node_modules, venv, and "
            ".gitignore matches. glob filters by file name (e.g. *.py). "
            "regex=true treats query as a Python/rg regular expression. "
            "Returns path:line:text (capped at 50 hits).",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                    "glob": {
                        "type": "string",
                        "default": "*",
                        "description": "File name glob, e.g. *.py. Default * = all text files.",
                    },
                    "regex": {
                        "type": "boolean",
                        "description": "If true, query is a regular expression.",
                    },
                },
                "required": ["query"],
            },
            search_text,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "codebase_overview",
            "Summarize workspace structure from the codebase index (dirs, suffixes, sample symbols). "
            "Use to understand what already exists before designing new work. "
            "Pass refresh=true after large external file changes.",
            {
                "type": "object",
                "properties": {
                    "refresh": {
                        "type": "boolean",
                        "description": "Force rebuild the index from disk.",
                    }
                },
                "required": [],
            },
            codebase_overview,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "codebase_find_similar",
            "Find existing files/symbols similar to an intended capability. "
            "REQUIRED before creating a new code file. Prefer reuse/extension when matches exist.",
            {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What you intend to build or change (capability, name, or path hint).",
                    },
                    "limit": {"type": "integer", "default": 12},
                },
                "required": ["query"],
            },
            codebase_find_similar,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "codebase_impact",
            "Estimate blast radius: files that reference a symbol or path. "
            "Call before editing shared modules.",
            {
                "type": "object",
                "properties": {
                    "symbol_or_path": {"type": "string"},
                    "limit": {"type": "integer", "default": 40},
                },
                "required": ["symbol_or_path"],
            },
            codebase_impact,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "coherence_checklist",
            "Return the Anti-Piling checklist (overlay / hardcode / control-flow / blast). "
            "Call near the end of LARGE structural work; answer each item with file evidence.",
            {"type": "object", "properties": {}, "required": []},
            coherence_checklist,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "git_status",
            "Show git status --short --branch for the workspace.",
            {"type": "object", "properties": {}, "required": []},
            git_status,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "git_diff",
            "Show git diff (optionally staged, optionally one path).",
            {
                "type": "object",
                "properties": {
                    "staged": {"type": "boolean", "default": False},
                    "path": {"type": "string", "description": "Optional path filter"},
                },
                "required": [],
            },
            git_diff,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "git_log",
            "Show recent commits (oneline).",
            {
                "type": "object",
                "properties": {"limit": {"type": "integer", "default": 12}},
                "required": [],
            },
            git_log,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "git_branch",
            "List local branches (-vv).",
            {"type": "object", "properties": {}, "required": []},
            git_branch,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "git_commit",
            "Stage tracked changes (git add -u) and commit with a message. Requires approval. "
            "Does not force-add untracked files.",
            {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
            git_commit,
            parallel_safe=False,
            requires_approval=True,
        )
    )
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
    for sk in list(skills):
        reg.register(_skill_as_tool(sk))

    reg.register(
        Tool(
            "skill_save",
            "Register a new skill_* function tool (writes SKILL.md under skills/learned).",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["name", "description", "content"],
            },
            skill_save,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "memory_append",
            "Save a durable note into the memory library (not the workspace). "
            "Pass category (creates it if missing), optional title and comma-separated tags. "
            "The user chooses which notes are injected via the Memory library. "
            "Requires user approval.",
            {
                "type": "object",
                "properties": {
                    "note": {"type": "string"},
                    "category": {
                        "type": "string",
                        "description": "Library category, e.g. General / a project name",
                    },
                    "title": {"type": "string"},
                    "tags": {
                        "type": "string",
                        "description": "Comma-separated tags",
                    },
                },
                "required": ["note"],
            },
            memory_append,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "memory_remove",
            "Delete one memory-library entry by id or by matching title/content/tags. "
            "Requires user approval.",
            {
                "type": "object",
                "properties": {
                    "match": {
                        "type": "string",
                        "description": "Substring to find in title/content/tags",
                    },
                    "memory_id": {
                        "type": "string",
                        "description": "Exact id from memory_list (preferred)",
                    },
                },
                "required": [],
            },
            memory_remove,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "memory_write",
            "Update one memory-library note. Prefer memory_id; otherwise creates a new note. "
            "Requires user approval.",
            {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "memory_id": {"type": "string"},
                    "category": {"type": "string"},
                    "title": {"type": "string"},
                    "tags": {"type": "string"},
                },
                "required": ["content"],
            },
            memory_write,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "memory_read",
            "Read memory-library notes. Optional filters: category, tags, memory_id. "
            "Includes disabled notes so you can see what exists; only enabled notes "
            "are auto-injected into the system prompt.",
            {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "tags": {"type": "string"},
                    "memory_id": {"type": "string"},
                },
                "required": [],
            },
            memory_read,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "memory_list",
            "List memory-library categories and notes (id, title, tags, ON/off). "
            "Use before memory_read/write when you need an id.",
            {"type": "object", "properties": {}, "required": []},
            memory_list,
            parallel_safe=True,
        )
    )

    if ask_user_fn is not None:

        def ask_user(
            question: str,
            options: list[str],
            allow_custom: bool = True,
            custom_label: str = "其他（请补充）",
        ) -> str:
            return ask_user_fn(
                question=question,
                options=normalize_option_labels(options),
                allow_custom=bool(allow_custom),
                custom_label=custom_label or "其他（请补充）",
            )

        reg.register(
            Tool(
                "ask_user",
                "Ask the user to clarify ONLY when a real decision or missing info blocks progress. "
                "Do NOT use ask_user to summarize the conversation, list past user tasks, or answer "
                "meta questions answerable from chat history — reply in normal assistant text instead. "
                "The UI shows clickable buttons; NEVER print numbered/lettered option "
                "lists in assistant text. Provide question + options (array of 2–12 "
                "short labels). Set allow_custom=true so the user can type a custom "
                "answer. Wait for the result before continuing.",
                {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "Clear question explaining what you need.",
                        },
                        "options": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 2,
                            "maxItems": 12,
                            "description": "2–12 choice labels shown as buttons.",
                        },
                        "allow_custom": {
                            "type": "boolean",
                            "description": "Show a free-text 'other' field (default true).",
                            "default": True,
                        },
                        "custom_label": {
                            "type": "string",
                            "description": "Label for the custom/other choice.",
                            "default": "其他（请补充）",
                        },
                    },
                    "required": ["question", "options"],
                },
                ask_user,
                parallel_safe=False,
            )
        )

    if allow_delegate and run_child is not None:

        def delegate_task(
            goal: str = "",
            context: str = "",
            role: str = "leaf",
            tasks: Optional[list[dict[str, Any]]] = None,
        ) -> str:
            items: list[dict[str, Any]]
            if tasks:
                items = tasks
            elif goal:
                items = [{"goal": goal, "context": context, "role": role}]
            else:
                return "ERROR: provide goal or tasks[]"

            if len(items) > settings.max_concurrent_children:
                return (
                    f"ERROR: max {settings.max_concurrent_children} children; got {len(items)}"
                )

            results: list[str | None] = [None] * len(items)

            def _one(idx: int, item: dict[str, Any]) -> tuple[int, str]:
                g = str(item.get("goal") or "").strip()
                ctx = str(item.get("context") or "").strip()
                r = str(item.get("role") or role or "leaf")
                if not g:
                    return idx, "ERROR: empty goal"
                try:
                    summary = run_child(goal=g, context=ctx, role=r)
                except Exception as exc:  # noqa: BLE001
                    summary = f"ERROR: child failed: {exc}"
                return idx, summary

            with ThreadPoolExecutor(max_workers=settings.max_concurrent_children) as pool:
                futs = [pool.submit(_one, i, it) for i, it in enumerate(items)]
                for fut in as_completed(futs):
                    i, summary = fut.result()
                    results[i] = summary

            payload = [
                {
                    "index": i,
                    "goal": items[i].get("goal"),
                    "summary": results[i],
                }
                for i in range(len(items))
            ]
            return json.dumps(payload, ensure_ascii=False, indent=2)

        reg.register(
            Tool(
                "delegate_task",
                "Spawn isolated subagent(s). Single: goal(+context,+role). "
                "Parallel: tasks=[{goal,context,role?}]. Only summaries return. "
                "Children have no parent history. role=orchestrator may re-delegate "
                "if depth allows.",
                {
                    "type": "object",
                    "properties": {
                        "goal": {"type": "string"},
                        "context": {"type": "string"},
                        "role": {
                            "type": "string",
                            "enum": ["leaf", "orchestrator"],
                            "default": "leaf",
                        },
                        "tasks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "goal": {"type": "string"},
                                    "context": {"type": "string"},
                                    "role": {"type": "string"},
                                },
                                "required": ["goal"],
                            },
                        },
                    },
                    "required": [],
                },
                delegate_task,
                parallel_safe=False,
            )
        )

    # Capability B: agent browser tools on the CDP sandbox session (same host as Select Mode).
    def browser_navigate(url: str = "") -> str:
        from ..services.browser_sandbox import SANDBOX

        target = (url or "").strip()
        if not target:
            return "ERROR: empty url"
        try:
            info = SANDBOX.navigate(target)
            return json.dumps(info, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_screenshot(full_page: bool = False, name: str = "") -> str:
        from ..services.browser_sandbox import SANDBOX

        try:
            path = SANDBOX.save_screenshot_to_workspace(
                live_ws(),
                name=(name or "").strip(),
                full_page=bool(full_page),
            )
            from ..core.pathutil import relative_to_posix

            rel = relative_to_posix(path, live_ws())
            return json.dumps({"path": rel, "abs": str(path)}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_console(limit: int = 40) -> str:
        from ..services.browser_sandbox import SANDBOX

        try:
            logs = SANDBOX.console_logs(limit=int(limit) if limit else 40)
            return json.dumps({"count": len(logs), "logs": logs}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_click(selector: str = "") -> str:
        from ..services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.click_selector(selector)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def browser_type(selector: str = "", text: str = "", clear: bool = True) -> str:
        from ..services.browser_sandbox import SANDBOX

        try:
            return SANDBOX.type_text(selector, text, clear=bool(clear))
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    reg.register(
        Tool(
            "browser_navigate",
            "Open a URL in Sidekick's CDP browser sandbox (Playwright Chromium). "
            "Prefer http://127.0.0.1 or http://localhost for local apps. "
            "Starts a headed session if needed. Same session as Select Mode.",
            {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
            browser_navigate,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_screenshot",
            "Capture the sandbox browser viewport to .sidekick/browser/*.png in the workspace.",
            {
                "type": "object",
                "properties": {
                    "full_page": {"type": "boolean", "default": False},
                    "name": {"type": "string", "description": "Optional filename"},
                },
                "required": [],
            },
            browser_screenshot,
            parallel_safe=False,
        )
    )
    reg.register(
        Tool(
            "browser_console",
            "Read recent console messages from the sandbox browser session.",
            {
                "type": "object",
                "properties": {"limit": {"type": "integer", "default": 40}},
                "required": [],
            },
            browser_console,
            parallel_safe=True,
        )
    )
    reg.register(
        Tool(
            "browser_click",
            "Click an element in the sandbox browser by CSS selector (or Playwright selector).",
            {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
            browser_click,
            parallel_safe=False,
            requires_approval=True,
        )
    )
    reg.register(
        Tool(
            "browser_type",
            "Type text into an input in the sandbox browser (fill by default).",
            {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "text": {"type": "string"},
                    "clear": {"type": "boolean", "default": True},
                },
                "required": ["selector", "text"],
            },
            browser_type,
            parallel_safe=False,
            requires_approval=True,
        )
    )

    if getattr(settings, "mcp_enabled", True):
        try:
            from ..services.mcp_runtime import register_mcp_tools

            register_mcp_tools(reg, Tool=Tool)
        except Exception as exc:  # noqa: BLE001
            from ..core.logutil import get_logger, log_exception

            log_exception(get_logger("metateam.tools"), "MCP tool registration failed", exc)

    return reg
