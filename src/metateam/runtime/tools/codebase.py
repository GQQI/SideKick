"""Codebase index / similarity / impact / coherence checklist."""

from __future__ import annotations

import json

from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_codebase_tools(reg: ToolRegistry, ctx: ToolContext) -> None:
    live_ws = ctx.live_ws
    align_state = ctx.align_state

    def codebase_overview(refresh: bool = False) -> str:
        from ...services import codebase_memory as cbm

        index = cbm.get_or_build_index(live_ws(), force=bool(refresh))
        ov = cbm.overview(index)
        return json.dumps(ov, ensure_ascii=False, indent=2)

    def codebase_find_similar(
        query: str = "",
        limit: int = 12,
        description: str = "",
    ) -> str:
        from ...services import codebase_memory as cbm

        q = (query or description or "").strip()
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
        from ...services import codebase_memory as cbm

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
        from ..coherence import PILE_CHECKLIST

        return (
            PILE_CHECKLIST
            + "\n\nReply against each item with evidence (paths). "
            "If any fail, fix by extending existing assets before you stop."
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
