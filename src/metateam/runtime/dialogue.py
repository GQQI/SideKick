"""Sequential multi-party session using live subagents (not a code simulator)."""

from __future__ import annotations

from typing import Any, Callable

MAX_SPEAKERS = 8
MAX_ROUNDS = 8


def format_transcript(turns: list[dict[str, Any]]) -> str:
    if not turns:
        return "(no prior turns — you act first)"
    parts: list[str] = []
    for t in turns:
        name = str(t.get("name") or "party")
        rnd = t.get("round") or "?"
        text = str(t.get("text") or "").strip()
        parts.append(f"[Round {rnd}] {name}:\n{text}")
    return "\n\n".join(parts)


def normalize_speakers(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("speakers must be a non-empty list")
    out: list[dict[str, str]] = []
    for item in raw[:MAX_SPEAKERS]:
        if isinstance(item, str):
            name = item.strip()
            brief = ""
        elif isinstance(item, dict):
            name = str(
                item.get("name") or item.get("role") or item.get("side") or ""
            ).strip()
            brief = str(
                item.get("brief")
                or item.get("stance")
                or item.get("goal")
                or item.get("position")
                or item.get("objective")
                or ""
            ).strip()
        else:
            continue
        if not name:
            continue
        out.append({"name": name, "brief": brief})
    if len(out) < 2:
        raise ValueError("need at least 2 parties")
    return out


def party_identity(
    *,
    name: str,
    brief: str,
    topic: str,
    mode: str = "",
    extra: str = "",
) -> str:
    brief_line = f"Your role / objective: {brief}\n" if brief else ""
    mode_line = f"Session type: {mode}\n" if mode else ""
    extra_line = f"Extra rules: {extra}\n" if extra else ""
    return (
        f"You are {name} in a live multi-agent session.\n"
        f"Scenario: {topic}\n"
        f"{mode_line}"
        f"{brief_line}"
        f"{extra_line}"
        "You are a full agent: use tools (search, files, browse, shell) and you "
        "may spawn other agents with delegate_task / delegate_dialogue when depth allows.\n"
        "Stay in this party's role for public output."
    ).strip()


def party_turn_prompt(*, round_no: int, rounds: int, transcript: str) -> str:
    return (
        f"This is round {round_no} of {rounds}.\n"
        f"Transcript so far:\n{transcript}\n\n"
        "Use any tools you need first if they would change your move, including "
        "spawning helper agents. Then output this party's public action this turn."
    )


def run_sequential_dialogue(
    *,
    run_child: Callable[..., str],
    topic: str,
    speakers: list[dict[str, str]],
    rounds: int = 3,
    extra: str = "",
    mode: str = "",
) -> dict[str, Any]:
    """One persistent full agent per party; later turns see the running transcript."""
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("topic is required")
    n_rounds = max(1, min(int(rounds or 3), MAX_ROUNDS))
    extra_s = (extra or "").strip()
    mode_s = (mode or "").strip()
    turns: list[dict[str, Any]] = []

    for rnd in range(1, n_rounds + 1):
        for sp in speakers:
            name = sp["name"]
            brief = sp.get("brief") or sp.get("stance") or ""
            identity = party_identity(
                name=name,
                brief=brief,
                topic=topic,
                mode=mode_s,
                extra=extra_s,
            )
            turn_user = party_turn_prompt(
                round_no=rnd,
                rounds=n_rounds,
                transcript=format_transcript(turns),
            )
            text = run_child(
                goal=identity,
                context=turn_user,
                role="orchestrator",
                kind="party",
                persist_key=name,
            )
            turns.append(
                {
                    "round": rnd,
                    "name": name,
                    "text": (text or "").strip() or "(empty)",
                }
            )

    lines = [f"# {topic}", ""]
    if mode_s:
        lines.append(f"_{mode_s}_")
        lines.append("")
    for t in turns:
        lines.append(f"**{t['name']}** (round {t['round']})")
        lines.append(t["text"])
        lines.append("")
    return {
        "topic": topic,
        "mode": mode_s,
        "rounds": n_rounds,
        "speakers": [s["name"] for s in speakers],
        "turns": turns,
        "transcript": "\n".join(lines).strip(),
    }
