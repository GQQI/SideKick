"""ask_user and delegate_task."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from ..ask import normalize_option_labels
from ..tool_registry import Tool, ToolRegistry
from .context import ToolContext


def register_ask_and_delegate(reg: ToolRegistry, ctx: ToolContext) -> None:
    settings = ctx.settings
    ask_user_fn = ctx.ask_user_fn
    run_child = ctx.run_child
    allow_delegate = ctx.run_child is not None

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
