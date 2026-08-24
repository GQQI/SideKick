"""ReAct agent with events, guardrails, compression, nested delegation."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .agent_execute import AgentExecuteMixin
from .agent_grounding import AgentGroundingMixin
from .agent_history import AgentHistoryMixin
from .approval import ApprovalGate
from .ask import (
    AskGate,
    MIN_ASK_OPTIONS,
    build_ask_options,
    normalize_option_labels,
    try_parse_inline_ask,
)
from ..core.config import Settings, get_settings
from .context import (
    context_budget_tokens,
    debug_dump_budget,
    ensure_fit,
    messages_tokens,
    schemas_tokens,
)
from ..core.events import EventBus, emit, new_id
from ..core.guardrails import Guardrails
from .llm import LLM
from .plan import (
    PLAN_PREP_HINT,
    PLAN_PREP_MAX_ROUNDS,
    PLAN_PREP_RETRY_HINT,
    PlanGate,
    apply_confirmed_plan,
    digest_plan_prep,
    extract_plan_goal,
    format_plan_markdown,
    generate_plan,
    goal_ready_to_plan,
    needs_plan,
    snapshot_plan_tasks,
)
from .prompts import build_system_prompt
from .coherence import inject_contract_into_goal, shape_contract_from_plan
from .review import run_review
from ..services.skills import Skill, load_skills
from .tools import ToolRegistry, build_registry

PrintFn = Callable[[str], None]


@dataclass
class AgentResult:
    text: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    iterations: int = 0
    compressed: bool = False
    agent_id: str = ""
    review: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False


class Agent(AgentHistoryMixin, AgentExecuteMixin, AgentGroundingMixin):
    def __init__(
        self,
        settings: Optional[Settings] = None,
        *,
        is_subagent: bool = False,
        role: str = "leaf",
        goal: str = "",
        context: str = "",
        depth: int = 0,
        parent_id: str = "",
        agent_id: Optional[str] = None,
        bus: Optional[EventBus] = None,
        on_event: Optional[PrintFn] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        turn_counter: int = 0,
        approval: Optional[ApprovalGate] = None,
        ask: Optional[AskGate] = None,
        plan_gate: Optional[PlanGate] = None,
    ):
        self.settings = (settings or get_settings()).clone()
        self.is_subagent = is_subagent
        self.role = role if role in ("leaf", "orchestrator") else "leaf"
        self.goal = goal
        self.context = context
        self.depth = depth
        self.parent_id = parent_id
        self.agent_id = agent_id or new_id("agent")
        self.session_id: Optional[str] = None
        self.bus = bus or EventBus()
        self.on_event = on_event
        self.turn_counter = turn_counter
        self.guard = Guardrails(same_call_fail_limit=self.settings.same_call_fail_limit)
        self._cancel = threading.Event()
        self.approval = approval or ApprovalGate()
        self.ask = ask or AskGate()
        self.plan_gate = plan_gate or PlanGate()
        self._children: list[Agent] = []
        self._allow_mutating_tools = True

        self.skills: list[Skill] = load_skills(self.settings.skills_dir)
        if is_subagent:
            self.llm = LLM(
                self.settings,
                model=self.settings.subagent_model,
                api_key=getattr(self.settings, "subagent_api_key", None) or self.settings.api_key,
                base_url=getattr(self.settings, "subagent_base_url", None) or self.settings.base_url,
            )
        else:
            self.llm = LLM(self.settings, model=self.settings.model)
        self.compress_llm = LLM(
            self.settings,
            model=self.settings.compress_model,
            api_key=getattr(self.settings, "compress_api_key", None) or self.settings.api_key,
            base_url=getattr(self.settings, "compress_base_url", None) or self.settings.base_url,
        )

        can_delegate = (not is_subagent) or (
            self.role == "orchestrator" and depth < self.settings.max_spawn_depth
        )
        self.registry: ToolRegistry = build_registry(
            self.settings,
            skills=self.skills,
            allow_delegate=can_delegate,
            run_child=self._run_child if can_delegate else None,
            ask_user_fn=self._ask_user,
        )
        # Sticky facts from tools (list_dir / codebase_*) so later turns don't invent paths.
        self.workspace_facts: list[str] = []
        self._turn_policy = None
        self._turn_mutated = False
        self._turn_verified = False

        if messages is not None:
            self.messages = messages
        else:
            system = build_system_prompt(
                workspace=self.settings.workspace,
                skills=self.skills,
                memory_file=self.settings.memory_file,
                is_subagent=is_subagent,
                role=self.role,
                goal=goal,
                context=context,
                depth=depth,
                max_depth=self.settings.max_spawn_depth,
            )
            self.messages = [{"role": "system", "content": system}]
        if not is_subagent:
            self._refresh_workspace_grounding()

    def request_cancel(self) -> None:
        self._cancel.set()
        # Close in-flight provider stream ASAP (do not wait for next chunk)
        try:
            self.llm.close_active_stream()
        except Exception as exc:
            from ..core.logutil import get_logger, log_exception

            log_exception(get_logger("metateam.agent"), "close_active_stream failed", exc)
        # Propagate to nested subagents
        for child in list(self._children):
            try:
                child.request_cancel()
            except Exception as exc:
                from ..core.logutil import get_logger, log_exception

                log_exception(get_logger("metateam.agent"), "child cancel failed", exc)
        # Unblock any waiting approvals / asks / plan confirms as rejected
        self.approval.cancel_all()
        self.ask.cancel_all()
        self.plan_gate.cancel_all()

    def clear_cancel(self) -> None:
        self._cancel.clear()

    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def _log(self, msg: str) -> None:
        if self.on_event:
            self.on_event(msg)

    def _emit(self, type_: str, data: Optional[dict[str, Any]] = None) -> None:
        emit(self.bus, type_, data, agent_id=self.agent_id, parent_id=self.parent_id)
        if data and "message" in (data or {}):
            self._log(str(data["message"]))

    def _run_child(self, *, goal: str, context: str = "", role: str = "leaf") -> str:
        child_role = role if role in ("leaf", "orchestrator") else "leaf"
        # Depth gate: only allow orchestrator if next depth still can spawn
        next_depth = self.depth + 1
        if child_role == "orchestrator" and next_depth >= self.settings.max_spawn_depth:
            child_role = "leaf"

        child_id = new_id("agent")
        self._emit(
            "subagent_start",
            {
                "child_id": child_id,
                "goal": goal,
                "role": child_role,
                "depth": next_depth,
                "message": f"spawn {child_role}: {goal[:100]}",
            },
        )
        child = Agent(
            self.settings,
            is_subagent=True,
            role=child_role,
            goal=goal,
            context=context,
            depth=next_depth,
            parent_id=self.agent_id,
            agent_id=child_id,
            bus=self.bus,
            on_event=self.on_event,
            approval=self.approval,
            ask=self.ask,
            plan_gate=self.plan_gate,
        )
        self._children.append(child)
        if self.cancelled():
            child.request_cancel()
        try:
            result = child.run("Begin now. Use tools, then summarize.")
        finally:
            self._children = [c for c in self._children if c is not child]
        self._emit(
            "subagent_end",
            {
                "child_id": child_id,
                "goal": goal,
                "summary": (result.text or "")[:2000],
                "iterations": result.iterations,
                "cancelled": bool(result.cancelled),
                "message": f"done: {goal[:60]}",
            },
        )
        return result.text or "(empty summary)"

    def _ask_user(
        self,
        *,
        question: str,
        options: list[str] | None = None,
        allow_custom: bool = True,
        custom_label: str = "其他（请补充）",
        # Legacy flat args (older prompts / cached tool calls)
        option_a: str = "",
        option_b: str = "",
        option_c: str = "",
        option_d: str = "",
    ) -> str:
        q = (question or "").strip()
        if not q:
            return "ERROR: empty question"

        labels = normalize_option_labels(options)
        if len(labels) < MIN_ASK_OPTIONS:
            legacy = [
                str(option_a or "").strip(),
                str(option_b or "").strip(),
                str(option_c or "").strip(),
            ]
            labels = [x for x in legacy if x]
            if str(option_d or "").strip():
                labels.append(str(option_d).strip())

        built = build_ask_options(labels)
        if len(built) < MIN_ASK_OPTIONS:
            return (
                f"ERROR: ask_user needs at least {MIN_ASK_OPTIONS} options; "
                f"got {len(built)}"
            )

        allow_other = bool(allow_custom)
        other_label = str(custom_label or "其他（请补充）").strip() or "其他（请补充）"
        ask_id = new_id("ask")
        call_id = new_id("call")
        self._emit("assistant_delta", {"chunk": "", "reset": True, "discard": True})
        self._emit(
            "ask_request",
            {
                "ask_id": ask_id,
                "call_id": call_id,
                "session_id": self.session_id or "",
                "question": q,
                "options": built,
                "allow_custom": allow_other,
                "custom_label": other_label,
                "summary": f"询问用户: {q[:120]}",
                "message": f"等待用户选择：{q[:80]}",
            },
        )
        answer = self.ask.request(
            ask_id,
            q,
            built,
            allow_custom=allow_other,
            custom_label=other_label,
        )
        self._emit(
            "ask_resolved",
            {
                "ask_id": ask_id,
                "call_id": call_id,
                "answer": answer,
                "message": "用户已回答" if not str(answer).startswith("ERROR:") else "询问已取消或超时",
            },
        )
        return answer

    def _maybe_compress(self) -> None:
        schemas = self.registry.schemas()
        before = context_budget_tokens(self.messages, schemas)
        limit = self.settings.context_limit
        self._emit(
            "context_usage",
            {
                "tokens": before,
                "limit": limit,
                "ratio": round(before / max(1, limit), 4),
                "messages_tokens": messages_tokens(self.messages),
                "schemas_tokens": schemas_tokens(schemas),
            },
        )
        trigger = int(limit * self.settings.compress_trigger_ratio)
        if before < trigger:
            return

        self._emit(
            "compress_start",
            {
                "before": before,
                "limit": limit,
                "attempt": 0,
                "max_attempts": self.settings.max_compress_attempts,
                "phase": "start",
                "message": "上下文接近上限，开始重置…",
            },
        )

        def _progress(info: dict[str, Any]) -> None:
            self._emit(
                "compress_progress",
                {
                    **info,
                    "before": before,
                    "limit": limit,
                },
            )

        # Reserve room for tools[] so compressed messages still fit with schemas
        msg_limit = max(4000, limit - schemas_tokens(schemas) - 256)
        self.messages, meta = ensure_fit(
            self.messages,
            context_limit=msg_limit,
            keep_recent_tokens=self.settings.keep_recent_tokens,
            trigger_ratio=self.settings.compress_trigger_ratio,
            max_attempts=self.settings.max_compress_attempts,
            llm=self.compress_llm,
            on_progress=_progress,
        )
        after = context_budget_tokens(self.messages, schemas)
        if meta.get("compressed"):
            self._last_compressed = True
        self._emit(
            "compress",
            {
                "before": before,
                "after": after,
                "limit": limit,
                "meta": meta,
                "phase": "done",
                "message": f"上下文已重置 {before}→{after}",
            },
        )
        self._emit(
            "context_usage",
            {
                "tokens": after,
                "limit": limit,
                "ratio": round(after / max(1, limit), 4),
                "messages_tokens": messages_tokens(self.messages),
                "schemas_tokens": schemas_tokens(schemas),
            },
        )

    def _run_plan_prep(self, user_text: str) -> tuple[str, int, bool, bool]:
        """Ask / inspect until the goal is concrete enough to draft tasks."""
        prep_start = len(self.messages)
        prep_schemas = self.registry.schemas(allow_mutating=False)
        prev_mutating = self._allow_mutating_tools
        self._allow_mutating_tools = False
        self.guard.set_explore_only(True)
        briefing = ""
        prep_iters = 0
        prep_cancelled = False
        prep_compressed = False
        gathered = ""
        round_iters = max(4, self.settings.max_iterations // 6)
        try:
            for round_i in range(PLAN_PREP_MAX_ROUNDS):
                self.guard.begin_plan_step()
                hint = PLAN_PREP_HINT if round_i == 0 else PLAN_PREP_RETRY_HINT
                self._emit(
                    "assistant_status",
                    {
                        "text": (
                            "正在了解需求（必要时会先提问或查看工作区）…"
                            if round_i == 0
                            else "需求仍不明确，继续澄清…"
                        ),
                        "tools": [],
                    },
                )
                self.messages.append(
                    {
                        "role": "user",
                        "content": hint,
                        "sidekick_internal": True,
                        "sidekick": {"internal": True, "kind": "plan_prep"},
                    }
                )
                briefing, iters, prep_cancelled, compressed = self._run_agent_loop(
                    round_iters,
                    tools=prep_schemas,
                    emit_assistant_text=False,
                )
                prep_iters += iters
                prep_compressed = prep_compressed or compressed
                if prep_cancelled or self.cancelled():
                    break
                gathered = digest_plan_prep(
                    self.messages, start=prep_start, briefing=briefing
                )
                if goal_ready_to_plan(self.compress_llm, user_text, gathered):
                    break
        finally:
            self._allow_mutating_tools = prev_mutating
            self.guard.set_explore_only(False)
        return gathered, prep_iters, prep_cancelled, prep_compressed

    def _run_plan_only(self, user_text: str) -> tuple[str, int, bool, bool]:
        """Gather with tools if needed, then confirm a plan, then execute."""
        gathered, prep_iters, prep_cancelled, prep_compressed = self._run_plan_prep(
            user_text
        )
        if prep_cancelled or self.cancelled():
            text = "已停止"
            return text, prep_iters, True, prep_compressed
        self._emit(
            "assistant_status",
            {"text": "正在生成方案（反堆砌形态合同）…", "tools": []},
        )
        plan = generate_plan(self.compress_llm, user_text, gathered=gathered)
        plan_id = str(plan["plan_id"])
        tasks: list[dict[str, Any]] = list(plan.get("tasks") or [])
        summary = str(plan.get("summary") or "执行计划")
        shape_contract = shape_contract_from_plan(plan)
        self._emit(
            "plan_created",
            {
                "plan_id": plan_id,
                "session_id": self.session_id or "",
                "summary": summary,
                "tasks": snapshot_plan_tasks(tasks),
                "shape_contract": shape_contract,
                "mode": "plan",
                "awaiting_confirm": True,
            },
        )
        self._emit(
            "plan_confirm_request",
            {
                "plan_id": plan_id,
                "session_id": self.session_id or "",
                "summary": summary,
                "tasks": snapshot_plan_tasks(tasks),
                "shape_contract": shape_contract,
                "message": f"等待确认方案：{summary[:80]}",
            },
        )
        approved, applied = self.plan_gate.request(
            plan_id, summary=summary, tasks=tasks
        )
        self._emit(
            "plan_confirm_resolved",
            {
                "plan_id": plan_id,
                "approved": approved,
                "message": "方案已确认，开始执行" if approved else "方案已取消",
            },
        )
        if not approved or self.cancelled():
            md = format_plan_markdown(plan, awaiting_confirm=False)
            self._emit("assistant_delta", {"chunk": "", "reset": True, "discard": True})
            self._emit("assistant_delta", {"chunk": md})
            self.messages.append({"role": "assistant", "content": md})
            self._emit(
                "plan_done",
                {
                    "plan_id": plan_id,
                    "message": "方案未执行",
                    "cancelled": True,
                },
            )
            return md, prep_iters, self.cancelled(), prep_compressed

        apply_confirmed_plan(
            plan,
            summary=str(applied.get("summary") or ""),
            tasks=applied.get("tasks") if isinstance(applied.get("tasks"), list) else None,
        )
        final, turned, cancelled, compressed = self._execute_plan(plan, user_text)
        return final, turned + prep_iters, cancelled, compressed or prep_compressed

    def _run_planned_agent(self, user_text: str) -> tuple[str, int, bool, bool]:
        plan = generate_plan(self.compress_llm, user_text)
        return self._execute_plan(plan, user_text)

    def _execute_plan(self, plan: dict[str, Any], user_text: str) -> tuple[str, int, bool, bool]:
        from .coherence import format_shape_contract_markdown

        plan_id = str(plan["plan_id"])
        tasks: list[dict[str, Any]] = list(plan.get("tasks") or [])
        shape_contract = shape_contract_from_plan(plan)
        summary = str(plan.get("summary") or "")
        self._emit(
            "plan_created",
            {
                "plan_id": plan_id,
                "summary": summary,
                "tasks": snapshot_plan_tasks(tasks),
                "shape_contract": shape_contract,
                "mode": "agent",
                "awaiting_confirm": False,
            },
        )
        intro = f"## {plan.get('summary') or '执行计划'}\n\n"
        if any(shape_contract.values()):
            intro += format_shape_contract_markdown(shape_contract) + "\n\n"
        intro += "将按任务列表逐步执行…\n"
        self._emit("assistant_delta", {"chunk": "", "reset": True})
        self._emit("assistant_delta", {"chunk": intro})

        per_step = max(8, self.settings.max_iterations // 3)
        turned = 0
        was_cancelled = False
        compressed = bool(getattr(self, "_last_compressed", False))
        step_notes: list[str] = []

        for i, task in enumerate(tasks):
            if self.cancelled():
                was_cancelled = True
                break
            tid = str(task.get("id") or new_id("task"))
            task["id"] = tid
            title = str(task.get("title") or f"步骤 {i + 1}")
            task["status"] = "running"
            self._emit(
                "plan_step",
                {
                    "plan_id": plan_id,
                    "task_id": tid,
                    "index": i,
                    "status": "running",
                    "title": title,
                    "summary": summary,
                    "tasks": snapshot_plan_tasks(tasks),
                },
            )
            self.guard.begin_plan_step()
            prior = "\n".join(f"- {s}" for s in step_notes) if step_notes else ""
            reuse = (
                "This is a continuation of the same turn, not a new request. "
                "Tool results already in this conversation remain valid — "
                "do not re-fetch files or listings that were already returned."
            )
            if i == 0:
                step_body = (
                    f"[Plan step 1/{len(tasks)}] {title}\n"
                    f"{task.get('detail') or ''}\n\n"
                    f"{reuse}\n"
                    "Complete only this step's scope. Reply with a brief summary "
                    "of what this step changed."
                )
            else:
                step_body = (
                    f"[Plan step {i + 1}/{len(tasks)}] {title}\n"
                    f"{task.get('detail') or ''}\n\n"
                    f"Already done:\n{prior}\n\n"
                    f"{reuse}\n"
                    "Complete only this step. Do not redo prior steps or pull in later steps."
                )
            # Full shape contract only on step 1; later steps get a short reminder.
            if i == 0:
                step_msg = inject_contract_into_goal(step_body, shape_contract)
            elif any(shape_contract.values()):
                step_msg = (
                    f"{step_body}\n\n"
                    "Keep following the plan's shape contract from step 1 "
                    "(reuse existing assets; no parallel reimplementation)."
                )
            else:
                step_msg = step_body
            self.messages.append(
                {
                    "role": "user",
                    "content": step_msg,
                    "sidekick_internal": True,
                    "sidekick": {"internal": True, "kind": "plan_step", "index": i},
                }
            )
            step_final, step_iters, step_cancelled, step_compressed = self._run_agent_loop(
                per_step
            )
            turned += step_iters
            if step_compressed:
                compressed = True
            if step_cancelled:
                was_cancelled = True
            from ..core.textutil import safe_clip

            note = f"{title}: {safe_clip((step_final or '').strip(), 400)}"
            step_notes.append(note)
            status = "done"
            if step_cancelled:
                status = "cancelled"
            elif (step_final or "").startswith("ERROR"):
                status = "error"
            task["status"] = status
            # Snapshot the full list so the UI does not depend on id/index matching.
            self._emit(
                "plan_step",
                {
                    "plan_id": plan_id,
                    "task_id": tid,
                    "index": i,
                    "status": status,
                    "title": title,
                    "summary": summary,
                    "tasks": snapshot_plan_tasks(tasks),
                },
            )
            if was_cancelled:
                break

        self._emit("plan_done", {"plan_id": plan_id, "message": "计划执行完成"})
        lines = [intro, "### 执行结果", ""]
        for note in step_notes:
            lines.append(f"- ✅ {note}")
        final = "\n".join(lines)
        self.messages.append({"role": "assistant", "content": final})
        self._emit("assistant_delta", {"chunk": "", "reset": True})
        self._emit("assistant_delta", {"chunk": final})
        return final, turned, was_cancelled, compressed

    def _run_agent_loop(
        self,
        max_iters: int,
        *,
        tools: Optional[list[dict[str, Any]]] = None,
        emit_assistant_text: bool = True,
    ) -> tuple[str, int, bool, bool]:
        """Run tool-calling loop until the model stops with text or max iters."""
        compressed = False
        final = ""
        turned = 0
        was_cancelled = False

        for i in range(1, max_iters + 1):
            if self.cancelled():
                was_cancelled = True
                break
            turned = i
            self._maybe_compress()
            if getattr(self, "_last_compressed", False):
                compressed = True
            schemas = tools if tools is not None else self.registry.schemas()
            self._emit(
                "llm_start",
                {
                    "turn": i,
                    "budget": json.loads(debug_dump_budget(self.messages)),
                    "tokens": context_budget_tokens(self.messages, schemas),
                    "messages_tokens": messages_tokens(self.messages),
                    "schemas_tokens": schemas_tokens(schemas),
                    "limit": self.settings.context_limit,
                },
            )
            assistant: Optional[dict[str, Any]] = None
            streamed_buf = ""
            if emit_assistant_text:
                self._emit("assistant_delta", {"chunk": "", "reset": True})
            try:
                for kind, payload in self.llm.stream_chat(
                    self.messages,
                    tools=schemas,
                    cancel_check=self.cancelled,
                ):
                    if self.cancelled():
                        was_cancelled = True
                        break
                    if kind == "delta":
                        streamed_buf += str(payload)
                        if emit_assistant_text:
                            self._emit("assistant_delta", {"chunk": str(payload)})
                    elif kind == "reasoning_delta":
                        self._emit(
                            "assistant_reasoning_delta",
                            {"chunk": str(payload)},
                        )
                    elif kind == "tool_delta" and isinstance(payload, dict):
                        self._emit("tool_call_delta", payload)
                    elif kind == "done":
                        assistant = payload  # type: ignore[assignment]
            except Exception:
                if self.cancelled():
                    was_cancelled = True
                    if streamed_buf.strip() and not final:
                        final = streamed_buf.strip()
                        self.messages.append({"role": "assistant", "content": final})
                    break
                if self.cancelled():
                    was_cancelled = True
                    break
                assistant = self.llm.chat(self.messages, tools=schemas)
                preamble_fb = (assistant.get("content") or "").strip()
                if preamble_fb and emit_assistant_text:
                    self._stream_text_to_ui(preamble_fb)

            if was_cancelled:
                if not final:
                    partial = ""
                    if isinstance(assistant, dict):
                        partial = str(assistant.get("content") or "").strip()
                    if not partial:
                        partial = streamed_buf.strip()
                    if partial:
                        final = partial
                        self.messages.append({"role": "assistant", "content": final})
                break
            if assistant is None:
                was_cancelled = True
                if streamed_buf.strip() and not final:
                    final = streamed_buf.strip()
                    self.messages.append({"role": "assistant", "content": final})
                break
            self.messages.append(assistant)

            tool_calls = assistant.get("tool_calls") or []
            preamble = (assistant.get("content") or "").strip()

            if not tool_calls:
                parsed_ask = try_parse_inline_ask(preamble)
                if parsed_ask:
                    self.messages.pop()
                    self._emit("assistant_delta", {"chunk": "", "reset": True, "discard": True})
                    answer = self._ask_user(
                        question=str(parsed_ask.get("question") or ""),
                        options=list(parsed_ask.get("options") or []),
                        allow_custom=bool(parsed_ask.get("allow_custom", True)),
                    )
                    self.messages.append({"role": "user", "content": answer})
                    continue

                final = preamble
                if not final:
                    reasoning = str(assistant.get("reasoning") or "").strip()
                    if reasoning:
                        final = (
                            reasoning
                            if len(reasoning) <= 3000
                            else reasoning[:3000] + "…"
                        )
                    else:
                        final = "（本轮已完成）"
                    self.messages[-1]["content"] = final
                    if emit_assistant_text:
                        self._emit("assistant_delta", {"chunk": "", "reset": True})
                        self._emit("assistant_delta", {"chunk": final})
                break

            names = [(tc.get("function") or {}).get("name", "?") for tc in tool_calls]
            self._emit(
                "assistant_status",
                {"text": f"调用工具：{', '.join(names)}", "tools": names},
            )
            if self.cancelled():
                was_cancelled = True
                break
            for tr in self._execute_tools(tool_calls):
                if self.cancelled():
                    was_cancelled = True
                    break
                self.messages.append(tr)
            if was_cancelled:
                break
        else:
            if not was_cancelled:
                self._emit("max_iterations", {"n": max_iters})
                if emit_assistant_text:
                    self.messages.append(
                        {
                            "role": "user",
                            "content": "Iteration budget exhausted. Summarize status and stop.",
                        }
                    )
                    final = self._stream_final_reply()
                else:
                    final = ""

        return final, turned, was_cancelled, compressed

    def run(
        self,
        user_text: str,
        *,
        mode: str = "agent",
        do_review: bool = True,
        display: str = "",
    ) -> AgentResult:
        # Top-level turns reset cancel; subagents keep a cancel already set by parent.
        if not self.is_subagent:
            self.clear_cancel()
            self.approval.begin_turn()
            self.guard.begin_turn()
            # Previous stop may have left unfinished tool_calls in history
            self._repair_dangling_tool_calls()
            # Re-pin live workspace truth so the model does not fall back to src/ priors
            self._refresh_workspace_grounding()
            self._apply_turn_coherence_policy(user_text)
            self._turn_mutated = False
            self._turn_verified = False
        user_turn = sum(1 for m in self.messages if m.get("role") == "user")
        user_msg: dict[str, Any] = {"role": "user", "content": user_text}
        disp = (display or "").strip()
        if disp and disp != user_text:
            user_msg["sidekick"] = {"display": disp}
        self.messages.append(user_msg)
        self.turn_counter += 1
        if not self.is_subagent and self.session_id:
            from ..services import fs_undo

            fs_undo.push_checkpoint(
                self.session_id, user_turn, user_text=disp or user_text
            )
            fs_undo.set_turn_context(self.session_id, user_turn)
            # Checkpoint early so a restart mid-turn still keeps the user message.
            try:
                from ..services.store import STORE

                STORE.persist(self.session_id)
            except Exception as exc:
                from ..core.logutil import get_logger, log_exception

                log_exception(
                    get_logger("metateam.agent"),
                    f"early persist failed for {self.session_id}",
                    exc,
                )
        self._emit(
            "turn_start",
            {"text": (disp or user_text)[:500], "message": "user turn"},
        )

        max_iters = (
            self.settings.subagent_max_iterations
            if self.is_subagent
            else self.settings.max_iterations
        )
        compressed = False
        self._last_compressed = False
        final = ""
        turned = 0
        was_cancelled = False
        mode_n = (mode or "agent").strip().lower()

        try:
            plan_goal = extract_plan_goal(user_text) or user_text
            if not self.is_subagent and mode_n == "plan":
                final, turned, was_cancelled, compressed = self._run_plan_only(plan_goal)
            elif not self.is_subagent and mode_n == "agent":
                self._emit(
                    "assistant_status",
                    {"text": "正在判断是否需要先出方案…", "tools": []},
                )
                if needs_plan(self.compress_llm, user_text):
                    # Model decides Plan-confirm; plan against the user ask,
                    # not Skill-template scaffolding.
                    final, turned, was_cancelled, compressed = self._run_plan_only(
                        plan_goal
                    )
                else:
                    final, turned, was_cancelled, compressed = self._run_agent_loop(
                        max_iters
                    )
            else:
                final, turned, was_cancelled, compressed = self._run_agent_loop(max_iters)

            if was_cancelled:
                self._emit("cancelled", {"message": "已停止生成"})
                # Strip unfinished tool chains so the next user message won't resume them
                final = self._seal_cancelled_turn(final or "")

            if not was_cancelled and not self.is_subagent:
                extra = self._maybe_auto_verify()
                if extra:
                    final = (final or "") + extra
                    self._emit("assistant_delta", {"chunk": extra})
                    updated = False
                    for m in reversed(self.messages):
                        if m.get("role") == "assistant" and not m.get("tool_calls"):
                            m["content"] = (m.get("content") or "") + extra
                            updated = True
                            break
                    if not updated:
                        self.messages.append({"role": "assistant", "content": extra.lstrip()})

            review: dict[str, Any] = {}
            if (
                do_review
                and not was_cancelled
                and not self.is_subagent
                and self.settings.auto_skill_review
                and self.turn_counter % max(1, self.settings.review_every_n_turns) == 0
            ):
                try:
                    review = run_review(self.settings, self.messages, llm=self.compress_llm)
                    if review.get("memory") or review.get("skill"):
                        self.skills = load_skills(self.settings.skills_dir)
                        self._emit("review", {"result": review, "message": "self-improve review"})
                except Exception as exc:  # noqa: BLE001
                    review = {"error": str(exc)}

            self._emit(
                "turn_end",
                {
                    "iterations": turned,
                    "tokens": context_budget_tokens(self.messages, self.registry.schemas()),
                    "message": "turn complete",
                    "cancelled": was_cancelled,
                },
            )
            return AgentResult(
                text=final,
                messages=self.messages,
                iterations=turned,
                compressed=compressed or bool(getattr(self, "_last_compressed", False)),
                agent_id=self.agent_id,
                review=review,
                cancelled=was_cancelled,
            )
        finally:
            if not self.is_subagent and self.session_id:
                from ..services import fs_undo

                fs_undo.clear_turn_context()

    def _stream_text_to_ui(self, text: str) -> None:
        if not text:
            return
        self._emit("assistant_delta", {"chunk": "", "reset": True})
        self._emit("assistant_delta", {"chunk": text})

    def _stream_final_reply(self) -> str:
        """Stream a tool-less completion into the UI; return full text."""
        self._emit("assistant_delta", {"chunk": "", "reset": True})
        parts: list[str] = []
        try:
            for piece in self.llm.stream_text(self.messages, cancel_check=self.cancelled):
                if self.cancelled():
                    break
                if not piece:
                    continue
                parts.append(piece)
                self._emit("assistant_delta", {"chunk": piece})
        except Exception:
            if self.cancelled():
                text = "".join(parts)
                self.messages.append({"role": "assistant", "content": text})
                return text
            assistant = self.llm.chat(self.messages, tools=None)
            text = assistant.get("content") or ""
            if text:
                self._stream_text_to_ui(text)
            self.messages.append({"role": "assistant", "content": text})
            return text

        text = "".join(parts)
        self.messages.append({"role": "assistant", "content": text})
        return text

def run_once(prompt: str, settings: Optional[Settings] = None) -> AgentResult:
    return Agent(settings).run(prompt)
