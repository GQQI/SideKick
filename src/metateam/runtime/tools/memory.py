"""Memory-library append / read / write / remove / list."""

from __future__ import annotations

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_memory_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    settings = ctx.settings

    def memory_append(
        note: str,
        category: str = "",
        title: str = "",
        tags: str = "",
    ) -> str:
        from ...services.memory import append_memory

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
        from ...services.memory import read_memory_detail

        return read_memory_detail(
            settings.memory_file,
            category=category,
            tags=tags,
            memory_id=memory_id,
            include_disabled=True,
            max_chars=8000,
        )

    def memory_list() -> str:
        from ...services.memory import list_library_text

        return list_library_text(settings.memory_file)

    def memory_remove(match: str = "", memory_id: str = "") -> str:
        from ...services.memory import remove_memory

        return remove_memory(settings.memory_file, match=match, memory_id=memory_id)

    def memory_write(
        content: str,
        memory_id: str = "",
        category: str = "",
        title: str = "",
        tags: str = "",
    ) -> str:
        from ...services.memory import replace_memory

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
