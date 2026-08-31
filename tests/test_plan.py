from __future__ import annotations

from metateam.runtime.plan import (
    is_multi_agent_request,
    parse_goal_ready_reply,
    parse_needs_plan_reply,
)


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


def test_multi_agent_request_skips_plan() -> None:
    assert is_multi_agent_request("启动两个智能体分别搜索再汇总") is True
    assert is_multi_agent_request("红蓝对抗，红方蓝方各说一轮") is True
    assert is_multi_agent_request("用 delegate_task 开 3 个工人") is True
    assert is_multi_agent_request("把首页按钮改成绿色") is False
    assert is_multi_agent_request("重构整个认证模块并迁移数据库") is False
