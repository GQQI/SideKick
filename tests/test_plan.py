from __future__ import annotations

from metateam.runtime.plan import parse_goal_ready_reply, parse_needs_plan_reply


def test_parse_goal_ready_json() -> None:
    assert parse_goal_ready_reply('{"ready": true, "reason": "named file"}') is True
    assert parse_goal_ready_reply('{"ready": false, "reason": "no object"}') is False
    assert parse_goal_ready_reply("not json") is None
    assert parse_goal_ready_reply("") is None


def test_parse_goal_ready_fenced() -> None:
    raw = '```json\n{"ready": false, "reason": "fragment"}\n```'
    assert parse_goal_ready_reply(raw) is False


def test_parse_needs_plan_still_works() -> None:
    assert parse_needs_plan_reply('{"plan": false}') is False
    assert parse_needs_plan_reply('{"plan": true, "reason": "refactor"}') is True
