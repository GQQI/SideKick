"""Read / write / search workspace files."""

from __future__ import annotations

from pathlib import Path

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext
from .support import _needs_codebase_align, _safe_path


def register_file_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws
    align_state = ctx.align_state

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
        from ...services import fs_api
        from ...services import codebase_memory as cbm

        try:
            target = _safe_path(live_ws(), path)
            try:
                from ...core.pathutil import is_relative_to, relative_to_posix

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
        from ...core.pathutil import is_relative_to, relative_to_posix
        from ...services import codebase_memory as cbm
        from ...services import fs_api
        from ...services.file_edit import apply_str_replace

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
        from ...services import fs_api
        from ...services import codebase_memory as cbm

        try:
            rel = path.replace("\\", "/")
            try:
                if Path(path).is_absolute():
                    from ...core.pathutil import relative_to_posix

                    rel = relative_to_posix(path, live_ws())
            except Exception:
                pass
            res = fs_api.delete_entry(rel, recursive=False)
            cbm.invalidate_index(live_ws())
            return f"deleted {res['path']}"
        except Exception as exc:
            return f"ERROR: {exc}"

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
        from ...services.repo_search import search_text as repo_search_text

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
