"""Transcript repair: cancel seals and dangling tool-call recovery."""

from __future__ import annotations

from typing import Any


class AgentHistoryMixin:
    def _is_internal_message(self, m: dict[str, Any]) -> bool:
        if m.get("sidekick_internal") or m.get("internal"):
            return True
        meta = m.get("sidekick")
        if isinstance(meta, dict) and meta.get("internal"):
            return True
        content = str(m.get("content") or "").lstrip()
        return content.startswith("[Plan step ") or content.startswith("[sidekick:")

    def _last_user_index(self) -> int:
        for i in range(len(self.messages) - 1, -1, -1):
            m = self.messages[i]
            if m.get("role") == "user" and not self._is_internal_message(m):
                return i
        return -1

    def _seal_cancelled_turn(self, partial_text: str = "") -> str:
        """Drop unfinished tool chains after stop so the next turn won't resume them."""
        last_user = self._last_user_index()
        if last_user < 0:
            return partial_text
        tail = self.messages[last_user + 1 :]
        if not tail and not (partial_text or "").strip():
            note = (
                "（用户已停止本轮生成。请等待下一条用户指令；"
                "不要继续或恢复刚才未完成的任务。）"
            )
            self.messages.append({"role": "assistant", "content": note})
            return note

        kept_bits: list[str] = []
        if (partial_text or "").strip():
            kept_bits.append(partial_text.strip())
        for m in tail:
            if m.get("role") != "assistant":
                continue
            if m.get("tool_calls") or self._is_internal_message(m):
                continue
            text = str(m.get("content") or "").strip()
            if text and text not in kept_bits:
                kept_bits.append(text)

        body = "\n\n".join(kept_bits).strip()
        note = (
            "（用户已停止本轮生成。请等待下一条用户指令；"
            "不要继续或恢复刚才未完成的任务。）"
        )
        if len(body) > 2500:
            from ..core.textutil import safe_clip

            body = safe_clip(body, 2500)
        content = f"{body}\n\n{note}" if body else note
        self.messages = self.messages[: last_user + 1]
        self.messages.append({"role": "assistant", "content": content})
        return content

    def _repair_dangling_tool_calls(self) -> None:
        """If history ends mid tool-call (e.g. crash), seal it before a new turn."""
        if not self.messages:
            return
        last_asst = -1
        for i in range(len(self.messages) - 1, -1, -1):
            m = self.messages[i]
            if m.get("role") == "assistant" and m.get("tool_calls"):
                last_asst = i
                break
            if m.get("role") == "user":
                break
        if last_asst < 0:
            return
        needed: set[str] = set()
        for tc in self.messages[last_asst].get("tool_calls") or []:
            cid = str(tc.get("id") or "")
            if cid:
                needed.add(cid)
        if not needed:
            return
        have: set[str] = set()
        for m in self.messages[last_asst + 1 :]:
            if m.get("role") == "tool":
                have.add(str(m.get("tool_call_id") or ""))
            elif m.get("role") in ("assistant", "user"):
                break
        if needed <= have:
            return
        user_idx = last_asst - 1
        while user_idx >= 0 and self.messages[user_idx].get("role") != "user":
            user_idx -= 1
        if user_idx < 0:
            return
        self.messages = self.messages[: user_idx + 1]
        self.messages.append(
            {
                "role": "assistant",
                "content": (
                    "（上一轮生成已中断。请等待用户下一条指令；"
                    "不要继续或恢复未完成的任务。）"
                ),
            }
        )
