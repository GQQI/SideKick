"""Installed skill_* tools and skill_save."""

from __future__ import annotations

from ...services.skills import load_skills
from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext
from .support import _skill_as_tool, save_skill_file


def register_skill_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    settings = ctx.settings
    skills = ctx.skills

    def skill_save(name: str, description: str, content: str) -> str:
        path = save_skill_file(settings, name, description, content)
        skills[:] = load_skills(settings.skills_dir)
        return f"saved skill_* function → {path} (reload session to refresh tools)"

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
