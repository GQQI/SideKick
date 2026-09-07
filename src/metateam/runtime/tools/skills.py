"""Installed skill_* tools and skill_save."""

from __future__ import annotations

from ...services.skills import (
    import_skill_dir,
    import_skill_markdown,
    is_skill_markdown,
    load_skills,
    write_skill,
)
from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext
from .support import _skill_as_tool


def register_skill_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    settings = ctx.settings
    skills = ctx.skills

    def _reload() -> None:
        skills[:] = load_skills(settings.skills_dir)
        reg.drop_skill_tools()
        for sk in skills:
            reg.register(_skill_as_tool(sk))

    def skill_save(
        name: str = "",
        description: str = "",
        content: str = "",
        from_path: str = "",
    ) -> str:
        """Install into the skill library (not the workspace)."""
        src = (from_path or "").strip()
        if src:
            from ...core.pathutil import resolve_existing_tool_path

            target = resolve_existing_tool_path(src, ctx.live_ws())
            try:
                if target.is_file() and is_skill_markdown(target):
                    if target.parent.resolve() == ctx.live_ws().resolve():
                        imported = [
                            import_skill_markdown(
                                settings.skills_dir,
                                target.read_text(encoding="utf-8"),
                                overwrite=True,
                                fallback_name=target.parent.name,
                            )
                        ]
                    else:
                        imported = import_skill_dir(
                            settings.skills_dir, target.parent, overwrite=True
                        )
                elif target.is_dir():
                    imported = import_skill_dir(
                        settings.skills_dir, target, overwrite=True
                    )
                else:
                    return (
                        "ERROR: from_path must be a folder with SKILL.md "
                        "or the SKILL.md file itself."
                    )
            except (ValueError, OSError, FileExistsError) as exc:
                return f"ERROR: {exc}"
            _reload()
            names = ", ".join(sk.name for sk in imported)
            dest = imported[0].path if imported else settings.skills_dir
            return (
                f"saved skill_* function(s) {names} → {dest} "
                "(/skills can load them on the next turn)"
            )
        if not (name.strip() and description.strip() and content.strip()):
            return (
                "ERROR: skill_save needs name + description + content, "
                "or from_path pointing at a skill folder / SKILL.md. "
                "Do not write skills into the workspace if you want /skills to load them."
            )
        try:
            sk = write_skill(
                settings.skills_dir,
                name=name,
                description=description,
                content=content,
                overwrite=True,
            )
        except (ValueError, OSError) as exc:
            return f"ERROR: {exc}"
        _reload()
        return (
            f"saved skill_* function → {sk.path} "
            "(/skills can load it on the next turn)"
        )

    for sk in list(skills):
        reg.register(_skill_as_tool(sk))

    reg.register(
        Tool(
            "skill_save",
            "Install a skill into the skill library (SKILLS_DIR), not the workspace. "
            "That library is what /skills and skill_* load. "
            "Pass name+description+content to create one, or from_path= a folder "
            "(or SKILL.md) already on disk — including a workspace download.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "content": {"type": "string"},
                    "from_path": {
                        "type": "string",
                        "description": (
                            "Optional. Workspace-relative folder or SKILL.md to import."
                        ),
                    },
                },
                "required": [],
            },
            skill_save,
            parallel_safe=False,
            requires_approval=True,
        )
    )
