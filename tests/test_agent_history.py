from __future__ import annotations

from metateam.runtime.agent_history import AgentHistoryMixin


class _Hist(AgentHistoryMixin):
    def __init__(self, messages):
        self.messages = messages


def test_internal_plan_step() -> None:
    h = _Hist([])
    assert h._is_internal_message({"role": "user", "content": "[Plan step 1] go"})
    assert h._is_internal_message({"role": "user", "sidekick_internal": True, "content": "x"})
    assert not h._is_internal_message({"role": "user", "content": "real question"})


def test_seal_cancelled_keeps_user() -> None:
    h = _Hist(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "do it"},
            {"role": "assistant", "content": "working", "tool_calls": [{"id": "c1"}]},
        ]
    )
    text = h._seal_cancelled_turn("partial")
    assert "已停止" in text
    assert h.messages[1]["role"] == "user"
    assert h.messages[-1]["role"] == "assistant"
    assert not any(m.get("tool_calls") for m in h.messages)


def test_repair_dangling_tool_calls() -> None:
    h = _Hist(
        [
            {"role": "user", "content": "go"},
            {"role": "assistant", "tool_calls": [{"id": "c1"}]},
        ]
    )
    h._repair_dangling_tool_calls()
    assert len(h.messages) == 2
    assert "已中断" in h.messages[-1]["content"]
