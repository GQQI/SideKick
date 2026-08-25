"""Workspace git status / diff / log / branch / commit."""

from __future__ import annotations

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_git_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws

    def git_status() -> str:
        from ...services import git_ops

        return git_ops.git_status(live_ws())

    def git_diff(staged: bool = False, path: str = "") -> str:
        from ...services import git_ops

        return git_ops.git_diff(live_ws(), staged=bool(staged), path=(path or "").strip())

    def git_log(limit: int = 12) -> str:
        from ...services import git_ops

        return git_ops.git_log(live_ws(), limit=limit)

    def git_branch() -> str:
        from ...services import git_ops

        return git_ops.git_branch(live_ws())

    def git_commit(message: str) -> str:
        from ...services import git_ops

        return git_ops.git_commit(live_ws(), message)

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
