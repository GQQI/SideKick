"""Chat SSE + reconnect."""

from __future__ import annotations

import contextvars
import queue
import threading
import time

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from ...core.events import Event
from ...core.logutil import get_logger, log_exception
from ...runtime.context import messages_tokens
from ...services.store import (
    STORE,
    _summarize_title,
    generate_session_title,
    is_untitled_session,
)
from ..http import require_session
from ..schemas import ChatRequest
from ..sse import event_payload, gate_replay_events, queue_sse, subscribe_bus

router = APIRouter(tags=["chat"])
_log = get_logger("metateam.api.chat")


@router.post("/api/chat")
async def chat_sse(req: ChatRequest) -> EventSourceResponse:
    sess = STORE.get(req.session_id) if req.session_id else None
    if sess is None:
        sess = STORE.create()

    display = (req.display or "").strip()
    title_src = display or req.message
    title_candidate = _summarize_title(title_src)
    needs_llm_title = is_untitled_session(sess.title) or len(sess.title) < 4
    if title_candidate and needs_llm_title:
        sess.title = title_candidate

    q: queue.Queue[dict | None] = queue.Queue()
    unsub = subscribe_bus(sess, q)

    def worker() -> None:
        try:
            q.put(
                event_payload(
                    "session",
                    {"session_id": sess.id, "demo": sess.agent.settings.demo_mode},
                    agent_id=sess.agent.agent_id,
                )
            )
            if needs_llm_title:
                try:
                    llm_title = generate_session_title(
                        sess.agent.llm,
                        req.message,
                        display=display,
                    )
                    if llm_title:
                        sess.title = llm_title
                except Exception as exc:
                    log_exception(_log, f"session title LLM failed for {sess.id}", exc)
            sess.updated_at = time.time()
            sess.busy = True
            result = sess.agent.run(
                req.message,
                mode=req.mode or "agent",
                display=display,
            )
            sess.updated_at = time.time()
            try:
                path = STORE.persist(sess.id)
                if not path:
                    _log.error("persist returned None for session %s", sess.id)
            except Exception as exc:
                log_exception(_log, f"persist failed for {sess.id}", exc)
            final_data = {
                "text": result.text,
                "iterations": result.iterations,
                "tokens": messages_tokens(result.messages),
                "review": result.review,
                "session_id": sess.id,
                "cancelled": result.cancelled,
                "title": sess.title,
            }
            q.put(event_payload("final", final_data, agent_id=sess.agent.agent_id))
            try:
                sess.agent.bus.emit(
                    Event(type="final", data=final_data, agent_id=sess.agent.agent_id)
                )
            except Exception as exc:
                log_exception(_log, f"emit final failed for {sess.id}", exc)
        except Exception as exc:
            try:
                STORE.persist(sess.id)
            except Exception as persist_exc:
                log_exception(_log, f"persist after error failed for {sess.id}", persist_exc)
            q.put(event_payload("error", {"message": str(exc)}))
        finally:
            sess.busy = False
            unsub()
            q.put(None)

    ctx = contextvars.copy_context()
    threading.Thread(target=ctx.run, args=(worker,), daemon=True).start()
    return queue_sse(q, on_disconnect=unsub)


@router.get("/api/sessions/{session_id}/events")
async def session_events(session_id: str) -> EventSourceResponse:
    """Re-attach to a live turn after refresh. Does not start a new agent run."""
    sess = require_session(session_id)
    q: queue.Queue[dict | None] = queue.Queue()
    unsub = subscribe_bus(sess, q)
    for item in gate_replay_events(sess):
        q.put(item)
    if not sess.busy:
        q.put(
            event_payload(
                "final",
                {
                    "text": "",
                    "session_id": sess.id,
                    "replay": True,
                    "cancelled": False,
                },
                agent_id=sess.agent.agent_id,
            )
        )
        q.put(None)
    return queue_sse(q, on_disconnect=unsub, on_close=unsub)
