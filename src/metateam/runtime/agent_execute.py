"""Tool-call execution, approval, and parallel batches."""

from __future__ import annotations

import contextvars
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from ..core.events import new_id
from .approval import approval_required, approval_scope, summarize_tool_call
from .llm import parse_tool_args
from .tools import plan_parallel_batches, prepare_tool_args

_TOOL_ALIASES = {
    "search": "web_search",
    "search_web": "web_search",
    "google_search": "web_search",
    "bing_search": "web_search",
    "internet_search": "web_search",
    "browser_snapshot": "browser_screenshot",
    "browser_get_page_content": "browser_get_page_content",
}


def _alias_tool_name(name: str) -> str:
    raw = (name or "").strip()
    return _TOOL_ALIASES.get(raw, raw)


class AgentExecuteMixin:
    def _execute_one(self, tc: dict[str, Any]) -> dict[str, Any]:
        fn = tc.get("function") or {}
        raw_name = fn.get("name") or ""
        name = _alias_tool_name(raw_name)
        args = parse_tool_args(fn.get("arguments") or "{}")
        tool = self.registry.get(name)
        call_id = str(tc.get("id") or new_id("call"))
        workspace = getattr(getattr(self, "settings", None), "workspace", None)
        scope = approval_scope(name, args, workspace)
        needs_ok = approval_required(name, tool, args=args, workspace=workspace)
        summary = summarize_tool_call(name, args, workspace=workspace)
        mutating = bool(needs_ok) or name in ("delegate_task", "delegate_dialogue")
        if mutating and not getattr(self, "_allow_mutating_tools", True):
            content = (
                "ERROR: still gathering information for the plan; "
                "mutating tools are unavailable. Use ask_user or inspect the "
                "workspace, then stop with a short briefing."
            )
            self._emit(
                "tool_start",
                {
                    "name": name,
                    "args": args,
                    "call_id": call_id,
                    "needs_approval": False,
                    "summary": summary,
                    "message": f"→ {name}",
                },
            )
            self._emit(
                "tool_end",
                {
                    "name": name,
                    "args": args,
                    "call_id": call_id,
                    "ok": False,
                    "preview": content[:400],
                    "result": content,
                    "message": f"← {name} blocked (plan prep)",
                },
            )
            return {
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": content,
            }
        preapproved = bool(needs_ok and self.approval.is_preapproved(scope))
        self._emit(
            "tool_start",
            {
                "name": name,
                "args": args,
                "call_id": call_id,
                "needs_approval": needs_ok and not preapproved,
                "summary": summary,
                "message": f"→ {name}",
            },
        )

        if needs_ok:
            if preapproved:
                self._emit(
                    "approval_auto",
                    {
                        "call_id": call_id,
                        "name": name,
                        "summary": summary,
                        "message": f"本轮已放行：{summary}",
                    },
                )
            else:
                with self.approval.serialize_ui():
                    if self.cancelled():
                        content = f"ERROR: cancelled — {summary}"
                        self.guard.after(name, args, content)
                        self._emit(
                            "tool_end",
                            {
                                "name": name,
                                "args": args,
                                "call_id": call_id,
                                "ok": False,
                                "preview": content[:400],
                                "result": content,
                                "message": f"← {name} cancelled",
                            },
                        )
                        return {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": name,
                            "content": content,
                        }
                    approval_id = new_id("appr")
                    self._emit(
                        "approval_request",
                        {
                            "approval_id": approval_id,
                            "call_id": call_id,
                            "name": name,
                            "args": args,
                            "summary": summary,
                            "message": f"等待确认：{summary}",
                        },
                    )
                    approved = self.approval.request(
                        approval_id, name, args, summary, scope=scope
                    )
                    self._emit(
                        "approval_resolved",
                        {
                            "approval_id": approval_id,
                            "call_id": call_id,
                            "name": name,
                            "approved": approved,
                            "message": "已批准" if approved else "已拒绝或超时",
                        },
                    )
                if not approved:
                    content = f"ERROR: user rejected or approval timed out — {summary}"
                    self.guard.after(name, args, content)
                    self._emit(
                        "tool_end",
                        {
                            "name": name,
                            "args": args,
                            "call_id": call_id,
                            "ok": False,
                            "preview": content[:400],
                            "result": content,
                            "message": f"← {name} rejected",
                        },
                    )
                    return {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": name,
                        "content": content,
                    }
            self._emit(
                "tool_start",
                {
                    "name": name,
                    "args": args,
                    "call_id": call_id,
                    "needs_approval": False,
                    "summary": summary,
                    "message": f"→ {name}",
                },
            )

        blocked = self.guard.before(name, args)
        if blocked:
            content = blocked
        elif not tool:
            known = ", ".join(self.registry.names()[:18])
            from ..core.hostinfo import network_available

            net_hint = (
                "Use web_search(query=...) for the public internet, "
                "search_text for workspace grep, or browser_navigate for a URL. "
                if network_available()
                else (
                    "This host is offline — do not call web_search. "
                    "Use search_text for workspace grep or read_file/list_dir. "
                )
            )
            content = (
                f"ERROR: unknown tool {raw_name or name}. "
                f"{net_hint}"
                f"Known tools include: {known}."
            )
        else:
            from ..services import fs_undo

            actor = "sub" if self.is_subagent else "main"
            if self.is_subagent:
                actor_label = (self.goal or "").strip().split("\n")[0][:80] or (
                    self.role or "sub"
                )
            else:
                actor_label = "main"
            fs_undo.set_mutation_meta(
                actor=actor,
                actor_label=actor_label,
                why=summary,
                tool=name,
                call_id=call_id,
            )
            try:
                content = tool.handler(**prepare_tool_args(name, tool.handler, args))
            except TypeError as exc:
                content = f"ERROR: bad arguments for {name}: {exc}"
            except Exception as exc:  # noqa: BLE001
                content = f"ERROR: {name} failed: {exc}"
            finally:
                fs_undo.clear_mutation_meta()

        if not blocked:
            self.guard.after(name, args, content)
        if len(content) > self.settings.tool_result_cap:
            from ..core.textutil import safe_clip

            content = safe_clip(
                content, self.settings.tool_result_cap, ellipsis="\n…[truncated]"
            )

        self._ingest_workspace_fact(name, args, content)
        self._emit_coherence_tool_events(name, args, content)

        if not content.startswith("ERROR"):
            if name in ("write_file", "str_replace", "delete_file"):
                self._turn_mutated = True
            if name == "verify_run":
                self._turn_verified = True
        from ..core.textutil import safe_clip

        self._emit(
            "tool_end",
            {
                "name": name,
                "args": args,
                "call_id": call_id,
                "ok": not content.startswith("ERROR"),
                "preview": safe_clip(content, 400),
                "result": safe_clip(content, 12_000, ellipsis="\n…[truncated]")
                if len(content) > 12_000
                else content,
                "message": f"← {name} ({len(content)} chars)",
            },
        )
        return {
            "role": "tool",
            "tool_call_id": call_id,
            "name": name,
            "content": content,
        }

    def _emit_coherence_tool_events(
        self, name: str, args: dict[str, Any], content: str
    ) -> None:
        """Surface Anti-Piling / verify signals to the UI."""
        if self.is_subagent:
            return
        if name == "codebase_find_similar":
            try:
                data = json.loads(content)
            except json.JSONDecodeError:
                data = {}
            matches = data.get("matches") if isinstance(data, dict) else None
            top = []
            if isinstance(matches, list):
                for m in matches[:5]:
                    if isinstance(m, dict) and m.get("path"):
                        top.append(
                            {
                                "path": str(m.get("path")),
                                "score": m.get("score"),
                                "symbols": m.get("symbols") or [],
                            }
                        )
            self._emit(
                "coherence_align",
                {
                    "query": str(args.get("query") or data.get("query") or ""),
                    "match_count": int(data.get("match_count") or len(top)),
                    "matches": top,
                    "message": f"对齐检索：{data.get('match_count', len(top))} 个候选",
                },
            )
        elif name == "coherence_checklist":
            self._emit(
                "coherence_pile",
                {
                    "status": "checklist_issued",
                    "message": "已下发检堆砌清单，请对照证据作答",
                },
            )
        elif name == "verify_run":
            passed = content.startswith("VERIFY PASS")
            self._emit(
                "verify_result",
                {
                    "ok": passed,
                    "command": str(args.get("command") or ""),
                    "preview": content[:500],
                    "message": "验收通过" if passed else "验收未通过",
                },
            )

    def _execute_tools(self, tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for batch in plan_parallel_batches(tool_calls, self.registry):
            if len(batch) == 1:
                results.append(self._execute_one(batch[0]))
                continue
            self._emit("parallel_batch", {"size": len(batch)})
            ordered: list[dict[str, Any] | None] = [None] * len(batch)
            with ThreadPoolExecutor(max_workers=min(8, len(batch))) as pool:
                futs = {
                    pool.submit(
                        contextvars.copy_context().run, self._execute_one, tc
                    ): i
                    for i, tc in enumerate(batch)
                }
                for fut in as_completed(futs):
                    ordered[futs[fut]] = fut.result()
            results.extend(r for r in ordered if r is not None)
        return results

    def _maybe_auto_verify(self) -> str:
        """Run a detected test/lint once after file mutations if the model skipped it."""
        if self.is_subagent or getattr(self, "_turn_verified", False):
            return ""
        if not getattr(self, "_turn_mutated", False):
            return ""
        from ..core.events import new_id
        from ..core.textutil import safe_clip
        from ..services.verify_detect import detect_verify_command

        cmd = detect_verify_command(self.settings.workspace)
        if not cmd:
            return ""
        if not self.settings.allow_shell:
            return (
                f"\n\n---\n未自动验收：shell 未开启。建议本地运行：`{cmd}`"
            )
        tool = self.registry.get("verify_run")
        if not tool:
            return ""
        args = {"command": cmd}
        summary = summarize_tool_call("verify_run", args)
        call_id = new_id("call")
        self._emit(
            "tool_start",
            {
                "name": "verify_run",
                "args": args,
                "call_id": call_id,
                "needs_approval": False,
                "summary": summary,
                "message": "→ verify_run (auto)",
            },
        )
        try:
            content = str(tool.handler(command=cmd) or "")
        except Exception as exc:  # noqa: BLE001
            content = f"ERROR: verify_run failed: {exc}"
        self._turn_verified = True
        passed = content.startswith("VERIFY PASS")
        self._emit(
            "tool_end",
            {
                "name": "verify_run",
                "args": args,
                "call_id": call_id,
                "ok": passed,
                "preview": safe_clip(content, 400),
                "result": safe_clip(content, 12_000, ellipsis="\n…[truncated]")
                if len(content) > 12_000
                else content,
                "message": f"← verify_run ({len(content)} chars)",
            },
        )
        self._emit(
            "verify_result",
            {
                "ok": passed,
                "command": cmd,
                "preview": content[:500],
                "auto": True,
                "message": "验收通过" if passed else "验收未通过",
            },
        )
        head = "\n".join(content.strip().splitlines()[:8])[:800]
        status = "通过" if passed else "未通过"
        return f"\n\n---\n自动验收 `{cmd}`：{status}\n{head}"
