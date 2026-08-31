"""ReAct agent with events, guardrails, compression, nested delegation."""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
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
    is_multi_agent_request,
    needs_plan,
    snapshot_plan_tasks,
)
from .prompts import build_system_prompt
from .coherence import inject_contract_into_goal, shape_contract_from_plan
from .review import run_review
from ..services.skills import Skill, load_skills
from .tools import ToolRegistry, build_registry

PrintFn = Callable[[str], None]


def _subagent_snapshot_item(
    child: Agent,
    party: str = "",
    *,
    turn: int = 0,
) -> dict[str, Any]:
    kind = "party" if child.full_agent else ("talk" if child.talk_only else "task")
    label = party or (child.goal or "").strip().split("\n")[0][:80]
    transcript: list[dict[str, Any]] = []
    for m in child.messages:
        role = m.get("role")
        if role == "assistant":
            text = str(m.get("content") or "").strip()
            reasoning = str(m.get("reasoning") or "").strip()
            try:
                from .text_tool_calls import extract_text_tool_calls

                text, xml_calls = extract_text_tool_calls(text)
            except Exception:
                xml_calls = []
            if text or reasoning:
                item: dict[str, Any] = {"kind": "assistant", "text": text}
                if reasoning:
                    item["reasoning"] = reasoning
                transcript.append(item)
            if not m.get("tool_calls"):
                for tc in xml_calls:
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                    name = str((fn or {}).get("name") or "").strip()
                    if name:
                        transcript.append({"kind": "tool", "name": name, "result": ""})
        elif role == "tool":
            transcript.append(
                {
                    "kind": "tool",
                    "name": str(m.get("name") or "tool"),
                    "result": str(m.get("content") or "")[:2000],
                }
            )
    return {
        "child_id": child.agent_id,
        "goal": child.goal or label,
        "role": child.role,
        "kind": kind,
        "party": party,
        "label": label,
        "parent_id": child.parent_id,
        "turn": turn,
        "replay": True,
        "transcript": transcript[-30:],
        "status": "running",
        "activity": "运行中…",
        "message": f"resume {child.role}: {label}",
    }


@dataclass
class AgentResult:
    text: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    iterations: int = 0
    compressed: bool = False
    agent_id: str = ""
    review: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False


_STALL_NUDGE = (
    "Your previous generation stalled (no progress). "
    "Continue the task now: call a tool or give a concise answer. "
    "Do not restart a long silent thinking pass."
)


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
        talk_only: bool = False,
        full_agent: bool = False,
    ):
        self.settings = (settings or get_settings()).clone()
        self.is_subagent = is_subagent
        if is_subagent:
            self._apply_subagent_context_budget()
        self.talk_only = bool(talk_only)
        self.full_agent = bool(full_agent) and not self.talk_only
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
        if is_subagent:
            # Research / paper-reading children legitimately open many files.
            self.guard.max_explore_streak = max(self.guard.max_explore_streak, 64)
        self._cancel = threading.Event()
        self._abandoned = False
        self.approval = approval or ApprovalGate()
        self.ask = ask or AskGate()
        self.plan_gate = plan_gate or PlanGate()
        self._children: list[Agent] = []
        self._party_agents: dict[str, Agent] = {}
        self._canvas_index: dict[str, dict[str, Any]] = {}
        self._canvas_turn = 0
        self._child_lock = threading.Lock()
        self._allow_mutating_tools = not self.talk_only

        self.skills: list[Skill] = [] if self.talk_only else load_skills(self.settings.skills_dir)
        llm_cap = int(getattr(self.settings, "max_tokens", 0) or 0) or None
        if is_subagent:
            self.llm = LLM(
                self.settings,
                model=self.settings.subagent_model,
                api_key=getattr(self.settings, "subagent_api_key", None) or self.settings.api_key,
                base_url=getattr(self.settings, "subagent_base_url", None) or self.settings.base_url,
                max_tokens=llm_cap,
            )
        else:
            self.llm = LLM(self.settings, model=self.settings.model, max_tokens=llm_cap)
        self.compress_llm = LLM(
            self.settings,
            model=self.settings.compress_model,
            api_key=getattr(self.settings, "compress_api_key", None) or self.settings.api_key,
            base_url=getattr(self.settings, "compress_base_url", None) or self.settings.base_url,
        )

        # Teams are intentionally one level deep: workers execute scoped work
        # and report to the lead; they never create invisible grandchild teams.
        can_delegate = (not self.talk_only) and not is_subagent
        self.registry: ToolRegistry = build_registry(
            self.settings,
            skills=self.skills,
            allow_delegate=can_delegate,
            run_child=self._run_child if can_delegate else None,
            ask_user_fn=None if self.talk_only or (is_subagent and not self.full_agent) else self._ask_user,
            talk_only=self.talk_only,
            end_party_session=self._end_party_session if can_delegate else None,
            note_canvas_tasks=self._note_canvas_tasks if can_delegate else None,
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
                talk_only=self.talk_only,
                full_agent=self.full_agent,
            )
            self.messages = [{"role": "system", "content": system}]
        if (not is_subagent) or self.full_agent:
            self._refresh_workspace_grounding()

    def _apply_subagent_context_budget(self) -> None:
        """Each child gets its own smaller window so a long debate cannot exhaust max_tokens."""
        s = self.settings
        parent_limit = max(4000, int(s.context_limit or 48000))
        explicit = int(getattr(s, "subagent_context_limit", 0) or 0)
        child_limit = explicit if explicit > 0 else int(parent_limit * 0.4)
        child_limit = max(8000, min(child_limit, 24000, parent_limit))
        s.context_limit = child_limit
        keep = int(s.keep_recent_tokens or 12000)
        s.keep_recent_tokens = min(keep, max(3000, child_limit // 3))
        ratio = float(s.compress_trigger_ratio or 0.72)
        s.compress_trigger_ratio = min(ratio, 0.55)
        cap = int(getattr(s, "tool_result_cap", 18000) or 18000)
        s.tool_result_cap = min(cap, 12000)
        parent_out = int(getattr(s, "max_tokens", 0) or 0)
        explicit = int(getattr(s, "subagent_max_tokens", 0) or 0)
        # 2048 used to cut tool JSON mid-stream → empty {} / truncated summaries.
        if explicit > 0:
            out_cap = explicit
        elif parent_out > 0:
            out_cap = parent_out
        else:
            out_cap = 8192
        if hasattr(s, "max_tokens"):
            s.max_tokens = out_cap
        if hasattr(s, "subagent_max_tokens"):
            s.subagent_max_tokens = out_cap

    def stop_generation(self) -> None:
        """Stop this agent tree's LLM streams without aborting parent asks/approvals."""
        self._cancel.set()
        try:
            self.llm.close_active_stream()
        except Exception as exc:
            from ..core.logutil import get_logger, log_exception

            log_exception(get_logger("metateam.agent"), "close_active_stream failed", exc)
        for child in list(self._children):
            try:
                child.stop_generation()
            except Exception as exc:
                from ..core.logutil import get_logger, log_exception

                log_exception(get_logger("metateam.agent"), "child cancel failed", exc)

    def request_cancel(self) -> None:
        self.stop_generation()
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
        if self._abandoned:
            return
        emit(self.bus, type_, data, agent_id=self.agent_id, parent_id=self.parent_id)
        if data and "message" in (data or {}):
            self._log(str(data["message"]))

    def _wait_child_run(self, child: "Agent", user_text: str) -> AgentResult:
        timeout = float(getattr(self.settings, "subagent_timeout", 0) or 0)
        if timeout <= 0:
            return child.run(user_text, do_review=False)
        pool = ThreadPoolExecutor(max_workers=1)
        fut = pool.submit(lambda: child.run(user_text, do_review=False))
        try:
            return fut.result(timeout=timeout)
        except FuturesTimeout:
            child.stop_generation()
            try:
                result = fut.result(timeout=12)
                text = (result.text or "").strip() or (
                    f"ERROR: subagent timed out after {int(timeout)}s "
                    "(stuck thinking). Parent should continue with other results."
                )
                return AgentResult(
                    text=text,
                    messages=result.messages,
                    iterations=result.iterations,
                    cancelled=False,
                    agent_id=child.agent_id,
                )
            except FuturesTimeout:
                child._abandoned = True
                return AgentResult(
                    text=(
                        f"ERROR: subagent timed out after {int(timeout)}s "
                        "(stuck thinking). Parent should continue with other results."
                    ),
                    cancelled=False,
                    agent_id=child.agent_id,
                )
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    def _run_child(
        self,
        *,
        goal: str,
        context: str = "",
        role: str = "leaf",
        kind: str = "task",
        persist_key: str = "",
        child_id: str = "",
    ) -> str:
        child_role = role if role in ("leaf", "orchestrator") else "leaf"
        next_depth = self.depth + 1
        if child_role == "orchestrator" and next_depth >= self.settings.max_spawn_depth:
            child_role = "leaf"
        kind_s = (kind or "task").strip().lower()
        talk_only = kind_s == "talk"
        full_agent = kind_s in ("party", "full")
        key = (persist_key or "").strip()
        resumed = bool(key and key in self._party_agents)
        preset_id = (child_id or "").strip()

        if resumed:
            child = self._party_agents[key]
            child_id = child.agent_id
        else:
            child_id = preset_id or new_id("agent")

        event_kind = "party" if full_agent else ("talk" if talk_only else "task")
        label = key or (goal or context or "").strip().split("\n")[0][:80]
        self._emit(
            "subagent_start",
            {
                "child_id": child_id,
                "goal": goal,
                "role": child_role,
                "depth": next_depth,
                "kind": event_kind,
                "party": key,
                "label": label,
                "resumed": resumed,
                "message": f"{'resume' if resumed else 'spawn'} {child_role}: {label}",
            },
        )
        if not resumed:
            child = Agent(
                self.settings,
                is_subagent=True,
                role=child_role,
                goal=goal,
                context="" if (full_agent or key) else context,
                depth=next_depth,
                parent_id=self.agent_id,
                agent_id=child_id,
                bus=self.bus,
                on_event=self.on_event,
                approval=self.approval,
                ask=self.ask,
                plan_gate=self.plan_gate,
                talk_only=talk_only,
                full_agent=full_agent,
            )
            with self._child_lock:
                self._children.append(child)
                if key:
                    self._party_agents[key] = child
        with self._child_lock:
            self._remember_canvas_child(child, party=key)
        self._emit_canvas_sync()
        if self.cancelled():
            child.request_cancel()
        if resumed or full_agent:
            user_text = (context or "").strip() or (goal or "").strip() or "Your turn."
        elif talk_only:
            user_text = (
                "Speak your turn now. Do not write code or files. "
                "Output only in-character dialogue."
            )
        else:
            user_text = "Begin now. Use tools, then summarize."
        result_text = "(empty summary)"
        iterations = 0
        cancelled = False
        try:
            result = self._wait_child_run(child, user_text)
            result_text = result.text or "(empty summary)"
            iterations = result.iterations
            cancelled = bool(result.cancelled)
        except Exception as exc:  # noqa: BLE001
            from ..core.logutil import get_logger, log_exception

            log_exception(get_logger("metateam.agent"), f"child {child_id} failed", exc)
            result_text = f"ERROR: child failed: {exc}"
            cancelled = True
        finally:
            with self._child_lock:
                self._ingest_canvas_subtree(
                    child,
                    party=key,
                    status="error" if cancelled or str(result_text).startswith("ERROR") else "done",
                )
                if not key:
                    self._children = [c for c in self._children if c is not child]
            self._emit_canvas_sync()
            self._emit(
                "subagent_end",
                {
                    "child_id": child_id,
                    "goal": goal,
                    "summary": (result_text or "")[:12000],
                    "iterations": iterations,
                    "cancelled": cancelled,
                    "message": f"done: {(goal or context)[:60]}",
                },
            )
        return result_text

    def _end_party_session(self) -> None:
        for name, child in list(self._party_agents.items()):
            self._ingest_canvas_subtree(child, party=name)
        for child in list(self._party_agents.values()):
            self._children = [c for c in self._children if c is not child]
        self._party_agents.clear()
        self._emit_canvas_sync()

    def _note_canvas_tasks(self, items: list[Any] | None) -> None:
        """Reserve a canvas slot for every queued worker, including those waiting on the pool."""
        turn = int(getattr(self, "_canvas_turn", 0) or 0)
        rows = items if isinstance(items, list) else []
        with self._child_lock:
            for raw in rows:
                if not isinstance(raw, dict):
                    continue
                cid = str(raw.get("child_id") or "").strip()
                goal = str(raw.get("goal") or "").strip()
                if not cid or not goal:
                    continue
                prev = self._canvas_index.get(cid)
                if isinstance(prev, dict) and str(prev.get("status") or "") in ("done", "error"):
                    continue
                label = goal.split("\n")[0][:80]
                self._canvas_index[cid] = {
                    "child_id": cid,
                    "parent_id": self.agent_id,
                    "goal": goal,
                    "role": str(raw.get("role") or "leaf"),
                    "kind": "task",
                    "party": "",
                    "label": label,
                    "turn": turn,
                    "replay": True,
                    "transcript": list(prev.get("transcript") or []) if isinstance(prev, dict) else [],
                    "status": "running",
                    "activity": "排队中…",
                    "message": f"queue leaf: {label}",
                    "children": [],
                }
        self._emit_canvas_sync()

    def _remember_canvas_child(self, child: Agent, party: str = "", *, status: str = "running") -> None:
        item = _subagent_snapshot_item(
            child,
            party,
            turn=int(getattr(self, "_canvas_turn", 0) or 0),
        )
        item["status"] = "error" if status == "error" else ("running" if status == "running" else "done")
        item["activity"] = "运行中…" if item["status"] == "running" else ""
        self._canvas_index[child.agent_id] = item

    def _ingest_canvas_subtree(self, child: Agent, party: str = "", *, status: str = "done") -> None:
        finished = "error" if str(status).startswith("error") else "done"
        self._remember_canvas_child(child, party, status=finished)
        kids = getattr(child, "_children", None)
        if isinstance(kids, list):
            for grand in list(kids):
                self._ingest_canvas_subtree(grand, status=finished)
        parties = getattr(child, "_party_agents", None)
        if isinstance(parties, dict):
            for name, grand in list(parties.items()):
                self._ingest_canvas_subtree(grand, party=str(name), status=finished)

    def _emit_canvas_sync(self) -> None:
        """Push the full spawn forest so the live canvas matches persisted history."""
        emit = getattr(self, "_emit", None)
        if not callable(emit):
            return
        # Nested leaves update the parent index via ingest; only the lead
        # (or a full party) owns the forest the UI should paint.
        if bool(getattr(self, "is_subagent", False)) and not bool(
            getattr(self, "full_agent", False)
        ):
            return
        try:
            emit(
                "canvas_sync",
                {
                    "tree": self.canvas_tree(),
                    "turn": int(getattr(self, "_canvas_turn", 0) or 0),
                },
            )
        except Exception:
            return

    def canvas_tree(self) -> list[dict[str, Any]]:
        """Durable forest of spawned agents (including finished nested helpers)."""
        by_id: dict[str, dict[str, Any]] = {}
        for item in self._canvas_index.values():
            if not isinstance(item, dict):
                continue
            cid = str(item.get("child_id") or "").strip()
            if not cid:
                continue
            by_id[cid] = {**item, "children": []}
        for item in self.live_subagent_snapshot():
            cid = str(item.get("child_id") or "").strip()
            if cid:
                prev = by_id.get(cid) or {}
                kids = prev.get("children") or []
                by_id[cid] = {**prev, **item, "children": kids}
        roots: list[dict[str, Any]] = []
        for item in by_id.values():
            pid = str(item.get("parent_id") or "").strip()
            parent = by_id.get(pid)
            if parent is not None:
                parent.setdefault("children", []).append(item)
            else:
                roots.append(item)
        return roots

    def live_subagent_snapshot(self) -> list[dict[str, Any]]:
        """Running children (including nested) so a reattached UI can restore cards."""
        out: list[dict[str, Any]] = []
        seen: set[str] = set()

        def party_name(agent: Agent, child: Agent) -> str:
            for name, party in agent._party_agents.items():
                if party is child or party.agent_id == child.agent_id:
                    return str(name)
            return ""

        def walk(agent: Agent) -> None:
            ordered: list[tuple[str, Agent]] = []
            local: set[str] = set()
            for child in list(agent._children):
                ordered.append((party_name(agent, child), child))
                local.add(child.agent_id)
            for name, child in list(agent._party_agents.items()):
                if child.agent_id in local:
                    continue
                ordered.append((str(name), child))
            for party, child in ordered:
                if child.agent_id in seen:
                    continue
                seen.add(child.agent_id)
                out.append(
                    _subagent_snapshot_item(
                        child,
                        party,
                        turn=int(getattr(self, "_canvas_turn", 0) or 0),
                    )
                )
                walk(child)

        walk(self)
        return out

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
        with self.ask.serialize_ui():
            if self.cancelled():
                return "ERROR: cancelled — proceed with a reasonable default or stop."
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

        # Reserve tools[] plus this agent's completion budget so prompt+output
        # cannot exceed the provider max_tokens / context window.
        gen_reserve = int(getattr(self.settings, "max_tokens", 0) or 0)
        if self.is_subagent and gen_reserve <= 0:
            gen_reserve = 2048
        msg_limit = max(4000, limit - schemas_tokens(schemas) - 256 - gen_reserve)
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
        stall_nudges = 0
        delegate_nudges = 0

        for i in range(1, max_iters + 1):
            if self.cancelled():
                was_cancelled = True
                break
            turned = i
            self._maybe_compress()
            if getattr(self, "_last_compressed", False):
                compressed = True
            schemas = tools if tools is not None else self.registry.schemas()
            if (
                getattr(self, "_requires_initial_delegation", False)
                and not getattr(self, "_delegation_started", False)
                and tools is None
            ):
                schemas = [
                    schema
                    for schema in schemas
                    if str((schema.get("function") or {}).get("name") or "")
                    in {"delegate_task", "delegate_dialogue"}
                ]
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
            stalled = False
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
                    if kind == "stalled":
                        stalled = True
                        reason = ""
                        if isinstance(payload, dict):
                            reason = str(payload.get("reason") or "")
                        self._emit(
                            "assistant_status",
                            {
                                "text": "思考卡住，已自动中断并继续",
                                "stalled": True,
                                "reason": reason,
                            },
                        )
                    elif kind == "delta":
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
                if stalled:
                    if assistant is None and streamed_buf.strip():
                        assistant = {"role": "assistant", "content": streamed_buf.strip()}
                else:
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
                if stalled and not self.cancelled():
                    stall_nudges += 1
                    self.messages.append(
                        {"role": "assistant", "content": streamed_buf.strip()}
                    )
                    if stall_nudges <= 2:
                        self.messages.append({"role": "user", "content": _STALL_NUDGE})
                        continue
                    final = streamed_buf.strip() or "（思考超时，已停止本轮）"
                    break
                was_cancelled = True
                if streamed_buf.strip() and not final:
                    final = streamed_buf.strip()
                    self.messages.append({"role": "assistant", "content": final})
                break
            self.messages.append(assistant)

            tool_calls = assistant.get("tool_calls") or []
            preamble = (assistant.get("content") or "").strip()

            if not tool_calls:
                if (
                    getattr(self, "_requires_initial_delegation", False)
                    and not getattr(self, "_delegation_started", False)
                    and delegate_nudges < 2
                ):
                    delegate_nudges += 1
                    self.messages.append(
                        {
                            "role": "user",
                            "sidekick_internal": True,
                            "content": (
                                "Use a native delegation tool now. Create exactly one batch call "
                                "for the requested workers; do not merely describe the call."
                            ),
                        }
                    )
                    continue
                parsed_ask = (
                    None
                    if self.is_subagent and not self.full_agent
                    else try_parse_inline_ask(preamble)
                )
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

                if stalled:
                    stall_nudges += 1
                    if stall_nudges <= 2:
                        self.messages.append({"role": "user", "content": _STALL_NUDGE})
                        continue
                    final = preamble or "（思考超时，已停止本轮）"
                    if not preamble:
                        self.messages[-1]["content"] = final
                    if emit_assistant_text:
                        self._emit("assistant_delta", {"chunk": "", "reset": True})
                        self._emit("assistant_delta", {"chunk": final})
                    break

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
            if any(name in ("delegate_task", "delegate_dialogue") for name in names):
                self._delegation_started = True
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
        from ..services.fs_api import bind_active_workspace, reset_active_workspace

        ws_token = bind_active_workspace(self.settings.workspace)
        try:
            return self._run_turn(
                user_text, mode=mode, do_review=do_review, display=display
            )
        finally:
            reset_active_workspace(ws_token)

    def _run_turn(
        self,
        user_text: str,
        *,
        mode: str = "agent",
        do_review: bool = True,
        display: str = "",
    ) -> AgentResult:
        self._delegation_started = False
        self._requires_initial_delegation = bool(
            not self.is_subagent and is_multi_agent_request(user_text)
        )
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
        elif self.full_agent:
            self._repair_dangling_tool_calls()
            self._refresh_workspace_grounding()
            self._turn_mutated = False
            self._turn_verified = False
        user_turn = sum(1 for m in self.messages if m.get("role") == "user")
        if not self.is_subagent:
            # Persisted agent scenes belong to one user turn. History can then
            # restore the matching team rather than every team ever spawned.
            self._canvas_turn = user_turn + 1
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
            self.settings.max_iterations
            if (not self.is_subagent or self.full_agent)
            else self.settings.subagent_max_iterations
        )
        compressed = False
        self._last_compressed = False
        final = ""
        turned = 0
        was_cancelled = False
        mode_n = (mode or "agent").strip().lower()

        try:
            plan_goal = extract_plan_goal(user_text) or user_text
            if not self.is_subagent and is_multi_agent_request(user_text):
                # Spawn / dialogue first. Plan confirm waits until this turn
                # is an implementation job, not a live multi-agent session.
                final, turned, was_cancelled, compressed = self._run_agent_loop(
                    max_iters
                )
            elif not self.is_subagent and mode_n == "plan":
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
