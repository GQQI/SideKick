"""SSE helpers — one place for queue → EventSourceResponse."""

from __future__ import annotations

import asyncio
import json
import queue
from collections.abc import Callable
from typing import Any

from sse_starlette.sse import EventSourceResponse

from ..core.events import PROTOCOL_VERSION, Event
from ..services.store import STORE, ChatSession

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


def event_payload(
    type_: str,
    data: dict[str, Any],
    *,
    agent_id: str = "",
    parent_id: str = "",
    ts: float = 0,
) -> dict[str, Any]:
    return {
        "type": type_,
        "data": data,
        "ts": ts,
        "agent_id": agent_id,
        "parent_id": parent_id,
        "protocol": PROTOCOL_VERSION,
    }


def queue_sse(
    q: queue.Queue[dict[str, Any] | None],
    *,
    on_disconnect: Callable[[], None] | None = None,
    on_close: Callable[[], None] | None = None,
) -> EventSourceResponse:
    async def gen():
        try:
            while True:
                item = await asyncio.get_event_loop().run_in_executor(None, q.get)
                if item is None:
                    break
                yield {
                    "event": item.get("type") or "message",
                    "data": json.dumps(item, ensure_ascii=False),
                }
        except asyncio.CancelledError:
            if on_disconnect:
                try:
                    on_disconnect()
                except Exception:
                    pass
            raise
        finally:
            if on_close:
                try:
                    on_close()
                except Exception:
                    pass

    return EventSourceResponse(gen(), headers=SSE_HEADERS)


def subscribe_bus(sess: ChatSession, q: queue.Queue[dict[str, Any] | None]) -> Callable[[], None]:
    def on_bus(ev: Event) -> None:
        q.put(ev.to_dict())

    return sess.agent.bus.subscribe(on_bus)


def gate_replay_events(sess: ChatSession) -> list[dict[str, Any]]:
    snap = STORE.runtime_snapshot(sess)
    agent_id = sess.agent.agent_id
    events: list[dict[str, Any]] = [
        event_payload(
            "session",
            {
                "session_id": sess.id,
                "demo": sess.agent.settings.demo_mode,
                "busy": snap["busy"],
            },
            agent_id=agent_id,
        )
    ]
    for item in snap.get("pending_approvals") or []:
        events.append(
            event_payload(
                "approval_request",
                {
                    "approval_id": item.get("id"),
                    "call_id": item.get("id"),
                    "name": item.get("tool"),
                    "args": item.get("args"),
                    "summary": item.get("summary"),
                    "message": item.get("summary"),
                },
                agent_id=agent_id,
            )
        )
    for item in snap.get("pending_asks") or []:
        events.append(
            event_payload(
                "ask_request",
                {
                    "ask_id": item.get("id"),
                    "call_id": item.get("id"),
                    "session_id": sess.id,
                    "question": item.get("question"),
                    "options": item.get("options") or [],
                    "allow_custom": item.get("allow_custom", True),
                    "custom_label": item.get("custom_label") or "",
                    "summary": item.get("question"),
                    "message": item.get("question"),
                },
                agent_id=agent_id,
            )
        )
    for item in snap.get("pending_plans") or []:
        events.append(
            event_payload(
                "plan_confirm_request",
                {
                    "plan_id": item.get("id"),
                    "session_id": sess.id,
                    "summary": item.get("summary"),
                    "tasks": item.get("tasks") or [],
                    "message": item.get("summary"),
                },
                agent_id=agent_id,
            )
        )
    for item in snap.get("live_subagents") or []:
        if not isinstance(item, dict):
            continue
        child_id = str(item.get("child_id") or "").strip()
        if not child_id:
            continue
        data = dict(item)
        data["replay"] = True
        data.setdefault("message", f"resume {data.get('role') or 'leaf'}")
        spawner = str(item.get("parent_id") or "") or agent_id
        nested = spawner != agent_id
        events.append(
            event_payload(
                "subagent_start",
                data,
                agent_id=spawner,
                parent_id=agent_id if nested else "",
            )
        )
    return events
