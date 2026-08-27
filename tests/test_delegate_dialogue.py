from __future__ import annotations

from metateam.runtime.dialogue import (
    normalize_speakers,
    run_sequential_dialogue,
)


def test_normalize_speakers_accepts_name_and_brief() -> None:
    got = normalize_speakers(
        [
            {"name": "红方", "brief": "夺控港口"},
            {"name": "蓝方", "stance": "守住港口"},
            {"name": "观察员"},
        ]
    )
    assert [s["name"] for s in got] == ["红方", "蓝方", "观察员"]
    assert got[0]["brief"] == "夺控港口"
    assert got[1]["brief"] == "守住港口"


def test_normalize_speakers_allows_eight_parties() -> None:
    raw = [{"name": f"方{i}"} for i in range(1, 9)]
    got = normalize_speakers(raw)
    assert len(got) == 8


def test_run_sequential_dialogue_passes_growing_transcript() -> None:
    seen: list[str] = []
    kinds: list[str] = []
    keys: list[str] = []

    def fake_child(
        *,
        goal: str,
        context: str,
        role: str,
        kind: str,
        persist_key: str = "",
    ) -> str:
        assert kind == "party"
        assert role == "orchestrator"
        seen.append(context)
        kinds.append(kind)
        keys.append(persist_key)
        if persist_key == "红方" or "红方" in goal:
            return "红方推进到港口外围。"
        return "蓝方加强岸防。"

    result = run_sequential_dialogue(
        run_child=fake_child,
        topic="港口争夺",
        speakers=normalize_speakers([{"name": "红方"}, {"name": "蓝方"}]),
        rounds=2,
        mode="推演",
    )
    assert result["speakers"] == ["红方", "蓝方"]
    assert len(result["turns"]) == 4
    assert keys == ["红方", "蓝方", "红方", "蓝方"]
    assert "no prior turns" in seen[0]
    assert "红方推进到港口外围" in seen[1]
    assert "蓝方加强岸防" in seen[2]
    assert "红方" in result["transcript"]
    assert "蓝方" in result["transcript"]


def test_live_subagent_snapshot_includes_party_and_nested() -> None:
    from metateam.runtime.agent import Agent

    parent = Agent.__new__(Agent)
    parent.agent_id = "main"
    parent._children = []
    parent._party_agents = {}

    party = Agent.__new__(Agent)
    party.agent_id = "party_red"
    party.parent_id = "main"
    party.full_agent = True
    party.talk_only = False
    party.goal = "You are 红方 in a live multi-agent session."
    party.role = "orchestrator"
    party.messages = [{"role": "assistant", "content": "红方推进。"}]
    party._children = []
    party._party_agents = {}

    nested = Agent.__new__(Agent)
    nested.agent_id = "leaf_1"
    nested.parent_id = "party_red"
    nested.full_agent = False
    nested.talk_only = False
    nested.goal = "侦察港口"
    nested.role = "leaf"
    nested.messages = []
    nested._children = []
    nested._party_agents = {}
    party._children = [nested]

    parent._children = [party]
    parent._party_agents = {"红方": party}

    snap = Agent.live_subagent_snapshot(parent)
    ids = [item["child_id"] for item in snap]
    assert ids == ["party_red", "leaf_1"]
    assert snap[0]["party"] == "红方"
    assert snap[0]["label"] == "红方"
    assert snap[0]["transcript"][0]["text"] == "红方推进。"
    assert snap[1]["goal"] == "侦察港口"
    assert snap[0]["parent_id"] == "main"
    assert snap[1]["parent_id"] == "party_red"


def test_ui_messages_marks_unfinished_tool_running() -> None:
    from types import SimpleNamespace

    from metateam.services.store import STORE

    sess = SimpleNamespace(
        agent=SimpleNamespace(
            messages=[
                {"role": "user", "content": "start agents"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "function": {
                                "name": "delegate_dialogue",
                                "arguments": '{"topic":"港口","speakers":[{"name":"红方"},{"name":"蓝方"}]}',
                            },
                        }
                    ],
                },
            ]
        )
    )
    out = STORE.ui_messages(sess)  # type: ignore[arg-type]
    tools = [m for m in out if m.get("role") == "tool"]
    assert len(tools) == 1
    assert tools[0]["name"] == "delegate_dialogue"
    assert tools[0]["status"] == "running"
