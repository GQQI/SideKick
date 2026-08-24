"""Context engineering: estimate, structured compress, hard trim, dual-pressure."""

from __future__ import annotations

import json
from typing import Any, Callable, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .llm import LLM


def estimate_tokens(text: str) -> int:
    """Heuristic token count (not a tokenizer). CJK ~1.6 chars/token, Latin/code ~3.2."""
    if not text:
        return 0
    cjk = 0
    other = 0
    for ch in text:
        o = ord(ch)
        if (
            0x4E00 <= o <= 0x9FFF
            or 0x3400 <= o <= 0x4DBF
            or 0x3000 <= o <= 0x303F
            or 0xFF00 <= o <= 0xFFEF
            or 0x3040 <= o <= 0x30FF
            or 0xAC00 <= o <= 0xD7AF
        ):
            cjk += 1
        else:
            other += 1
    return max(1, int(cjk / 1.6 + other / 3.2))


def _content_text(msg: dict[str, Any]) -> str:
    content = msg.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
            else:
                parts.append(str(p))
        return "\n".join(parts)
    return str(content)


def message_tokens(msg: dict[str, Any]) -> int:
    n = estimate_tokens(_content_text(msg))
    n += estimate_tokens(str(msg.get("reasoning") or msg.get("reasoning_content") or ""))
    n += estimate_tokens(str(msg.get("name") or ""))
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        n += estimate_tokens(fn.get("name", "")) + estimate_tokens(fn.get("arguments", ""))
        n += 8
    n += estimate_tokens(str(msg.get("tool_call_id") or ""))
    return n + 8


def messages_tokens(messages: list[dict[str, Any]]) -> int:
    return sum(message_tokens(m) for m in messages)


def schemas_tokens(schemas: Optional[list[dict[str, Any]]]) -> int:
    """Estimate tokens for the tools[] payload sent every LLM turn."""
    if not schemas:
        return 0
    try:
        return estimate_tokens(json.dumps(schemas, ensure_ascii=False))
    except Exception:
        return 0


def context_budget_tokens(
    messages: list[dict[str, Any]],
    schemas: Optional[list[dict[str, Any]]] = None,
    *,
    overhead: int = 256,
) -> int:
    """Messages + tool schemas + small fixed overhead (closer to real API spend)."""
    return messages_tokens(messages) + schemas_tokens(schemas) + overhead


_COMPRESS_PROMPT = """You compress agent transcripts into durable working memory.

Output EXACTLY these markdown sections:
## Goal
## Progress
## Decisions
## Artifacts
## Workspace
## Open Issues
## Next

Rules:
- Prefer paths, commands, error strings, IDs that must survive.
- ## Workspace MUST list confirmed files/dirs from tools (e.g. only index.html). Never invent src/ if not observed.
- Drop raw tool dumps and chit-chat.
- Match the user's language.
- Keep under 900 tokens."""


def _stringify_for_summary(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for m in messages:
        role = m.get("role", "?")
        content = m.get("content") or ""
        if m.get("tool_calls"):
            names = [(tc.get("function") or {}).get("name", "?") for tc in m["tool_calls"]]
            content = (content + "\n" if content else "") + f"[tools: {', '.join(names)}]"
        if role == "tool":
            content = content[:900] + ("…" if len(content) > 900 else "")
            parts.append(f"tool: {content}")
        else:
            parts.append(f"{role}: {str(content)[:2200]}")
    return "\n\n".join(parts)


def _hard_trim_tool_payloads(messages: list[dict[str, Any]], cap: int = 1200) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.get("role") == "tool" and isinstance(m.get("content"), str) and len(m["content"]) > cap:
            nm = dict(m)
            nm["content"] = m["content"][:cap] + "\n…[truncated]"
            out.append(nm)
        else:
            out.append(m)
    return out


def _split_keep_recent(
    messages: list[dict[str, Any]], keep_recent_tokens: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not messages:
        return [], []
    tail: list[dict[str, Any]] = []
    used = 0
    i = len(messages) - 1
    while i >= 0:
        m = messages[i]
        if m.get("role") == "tool":
            block = [m]
            j = i - 1
            while j >= 0 and messages[j].get("role") == "tool":
                block.insert(0, messages[j])
                j -= 1
            if j >= 0 and messages[j].get("role") == "assistant" and messages[j].get("tool_calls"):
                block.insert(0, messages[j])
                j -= 1
            block_cost = sum(message_tokens(x) for x in block)
            if tail and used + block_cost > keep_recent_tokens:
                break
            tail = block + tail
            used += block_cost
            i = j
            continue
        cost = message_tokens(m)
        if tail and used + cost > keep_recent_tokens:
            break
        tail.insert(0, m)
        used += cost
        i -= 1
    head = messages[: i + 1] if i >= 0 else []
    return head, tail


def compress_messages(
    messages: list[dict[str, Any]],
    *,
    context_limit: int,
    keep_recent_tokens: int,
    trigger_ratio: float,
    llm: Optional["LLM"],
    prior_summary: str = "",
) -> tuple[list[dict[str, Any]], str, bool]:
    if not messages:
        return messages, prior_summary, False

    total = messages_tokens(messages)
    if total < int(context_limit * trigger_ratio):
        return messages, prior_summary, False

    system = messages[0] if messages[0].get("role") == "system" else None
    body = messages[1:] if system else list(messages)

    # Soft prune tool payloads first (lighter than full summary)
    pruned = _hard_trim_tool_payloads(body, cap=2500)
    if messages_tokens(([system] if system else []) + pruned) < int(context_limit * trigger_ratio):
        return ([system] if system else []) + pruned, prior_summary, True

    head, tail = _split_keep_recent(pruned, keep_recent_tokens)
    if not head:
        tail = _hard_trim_tool_payloads(tail, cap=800)
        head, tail = _split_keep_recent(tail, keep_recent_tokens)
    if not head:
        return ([system] if system else []) + tail, prior_summary, False

    blob = _stringify_for_summary(head)
    if prior_summary:
        blob = f"PREVIOUS SUMMARY:\n{prior_summary}\n\nNEW TURNS:\n{blob}"

    summary = ""
    if llm is not None:
        try:
            summary = llm.complete_text(_COMPRESS_PROMPT, blob[:140_000])
        except Exception as exc:  # noqa: BLE001
            summary = f"(compress failed: {exc})\n" + blob[:3500]
    if not summary:
        summary = blob[:3500]

    synthetic = {
        "role": "user",
        "content": "[CONTEXT COMPACTION]\n" + summary,
    }
    rebuilt = ([system] if system else []) + [synthetic] + tail
    return rebuilt, summary, True


def ensure_fit(
    messages: list[dict[str, Any]],
    *,
    context_limit: int,
    keep_recent_tokens: int,
    trigger_ratio: float,
    max_attempts: int,
    llm: Optional["LLM"],
    on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (messages, meta)."""
    summary = ""
    cur = messages
    meta = {"attempts": 0, "compressed": False, "final_tokens": 0}
    for attempt in range(max_attempts):
        tokens_now = messages_tokens(cur)
        if on_progress:
            on_progress(
                {
                    "phase": "compressing",
                    "attempt": attempt + 1,
                    "max_attempts": max_attempts,
                    "tokens": tokens_now,
                    "limit": context_limit,
                    "message": f"压缩上下文中（第 {attempt + 1}/{max_attempts} 轮）…",
                }
            )
        cur, summary, did = compress_messages(
            cur,
            context_limit=context_limit,
            keep_recent_tokens=keep_recent_tokens,
            trigger_ratio=trigger_ratio,
            llm=llm,
            prior_summary=summary,
        )
        meta["attempts"] = attempt + 1
        if did:
            meta["compressed"] = True
        if messages_tokens(cur) < int(context_limit * trigger_ratio):
            meta["final_tokens"] = messages_tokens(cur)
            meta["summary_preview"] = summary[:400]
            return cur, meta

    if on_progress:
        on_progress(
            {
                "phase": "hard_trim",
                "attempt": max_attempts,
                "max_attempts": max_attempts,
                "tokens": messages_tokens(cur),
                "limit": context_limit,
                "message": "压缩不足，正在硬裁剪上下文…",
            }
        )
    system = cur[0] if cur and cur[0].get("role") == "system" else None
    body = cur[1:] if system else cur
    body = _hard_trim_tool_payloads(body, cap=500)
    while messages_tokens(([system] if system else []) + body) > context_limit and len(body) > 3:
        body = body[1:]
    out = ([system] if system else []) + body
    meta["final_tokens"] = messages_tokens(out)
    meta["hard_trimmed"] = True
    return out, meta


def debug_dump_budget(messages: list[dict[str, Any]]) -> str:
    return json.dumps(
        {"messages": len(messages), "tokens_est": messages_tokens(messages)},
        ensure_ascii=False,
    )
