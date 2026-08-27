"""ask_user and delegate_task."""

from __future__ import annotations

import contextvars
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
                futs = [
                    pool.submit(contextvars.copy_context().run, _one, i, it)
                    for i, it in enumerate(items)
                ]
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

        def delegate_dialogue(
            topic: str = "",
            speakers: Optional[list[Any]] = None,
            rounds: int = 3,
            extra: str = "",
            mode: str = "",
        ) -> str:
            from ..dialogue import normalize_speakers, run_sequential_dialogue

            try:
                parsed = normalize_speakers(speakers)
                n_rounds = max(1, min(int(rounds or 3), 8))
                mode_s = (mode or "").strip()
                topic_s = (topic or "").strip()
                try:
                    result = run_sequential_dialogue(
                        run_child=run_child,
                        topic=topic_s,
                        speakers=parsed,
                        rounds=n_rounds,
                        extra=extra,
                        mode=mode_s,
                    )
                finally:
                    end = ctx.end_party_session
                    if end is not None:
                        end()
            except ValueError as exc:
                return f"ERROR: {exc}"
            except Exception as exc:  # noqa: BLE001
                return f"ERROR: dialogue failed: {exc}"
            return json.dumps(result, ensure_ascii=False, indent=2)

        reg.register(
            Tool(
                "delegate_task",
                "DEFAULT: spawn isolated subagent(s) for work (search, research, "
                "edit, gather sources). Parallel: tasks=[{goal,context,role?}]. "
                "Parent gets summaries and synthesizes. Children cannot hear each "
                "other. Use this when the user wants several agents to work "
                "separately then merge — NOT delegate_dialogue. "
                "Children may re-delegate if spawn depth remains.",
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
        reg.register(
            Tool(
                "delegate_dialogue",
                "ONLY for live in-character turns where parties hear each other "
                "(debate, negotiation, military sim, tabletop) — 2 to 8 named "
                "parties. Each party is a FULL agent with the same tools as you, "
                "kept across rounds, and may spawn further agents. "
                "NOT for parallel research, search, or 'start N agents then "
                "summarize' — that is delegate_task. Do NOT write a code simulator. "
                "Do NOT enter Plan mode. If the user did not specify the exact "
                "scenario, party list, or format, ask_user and/or search first. "
                "speakers: [{name, brief}]. mode is a free label. rounds: 1–8.",
                {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "Scenario in the user's own words. Do not invent a motion they did not state.",
                        },
                        "mode": {
                            "type": "string",
                            "description": "Free-form session type, e.g. simulation, negotiation, debate, tabletop.",
                        },
                        "speakers": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 8,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "Party name (any label: 红方, NATO, 调解人, …).",
                                    },
                                    "brief": {
                                        "type": "string",
                                        "description": "That party's role, objective, or constraints.",
                                    },
                                    "stance": {
                                        "type": "string",
                                        "description": "Alias of brief.",
                                    },
                                },
                                "required": ["name"],
                            },
                        },
                        "rounds": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 8,
                            "default": 3,
                            "description": "How many full cycles through all parties.",
                        },
                        "extra": {
                            "type": "string",
                            "description": "Optional extra rules (fog of war, time, scoring).",
                        },
                    },
                    "required": ["topic", "speakers"],
                },
                delegate_dialogue,
                parallel_safe=False,
            )
        )
