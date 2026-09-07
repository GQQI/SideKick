"""Push a completion notice into the owning chat when a background job ends."""

from __future__ import annotations

import time
from typing import Any

from ..core.events import Event
from ..core.logutil import get_logger, log_exception
from .shell_jobs import ShellJob, format_job_done_notice

_log = get_logger("metateam.shell_jobs")


def _already_posted(messages: list[dict[str, Any]], job_id: str) -> bool:
    for m in messages:
        meta = m.get("sidekick")
        if isinstance(meta, dict) and meta.get("kind") == "shell_job_done" and meta.get("job_id") == job_id:
            return True
    return False


def _notice_message(job: ShellJob) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": format_job_done_notice(job),
        "ts": time.time(),
        "sidekick": {
            "kind": "shell_job_done",
            "job_id": job.id,
            "status": job.status,
            "exit_code": job.exit_code,
        },
    }


def flush_pending_job_notices(session_id: str) -> None:
    from .store import STORE

    sess = STORE.get(session_id)
    if not sess or not sess.pending_job_notices:
        return
    pending = list(sess.pending_job_notices)
    sess.pending_job_notices.clear()
    msgs = sess.agent.messages
    added = 0
    for msg in pending:
        meta = msg.get("sidekick") if isinstance(msg.get("sidekick"), dict) else {}
        jid = str(meta.get("job_id") or "")
        if jid and _already_posted(msgs, jid):
            continue
        msgs.append(msg)
        added += 1
    if added:
        try:
            STORE.persist(session_id)
        except Exception as exc:
            log_exception(_log, f"persist job notices failed for {session_id}", exc)


def deliver_job_done(job: ShellJob) -> None:
    sid = (job.session_id or "").strip()
    if not sid:
        return
    from .store import STORE

    sess = STORE.get(sid)
    if not sess:
        return
    notice = _notice_message(job)
    payload = {
        **job.snapshot(tail=40),
        "phase": "done",
        "message": notice["content"],
    }
    try:
        sess.agent.bus.emit(Event(type="shell_job", data=payload, agent_id=sess.agent.agent_id))
    except Exception as exc:
        log_exception(_log, f"emit shell_job done failed for {sid}", exc)

    if _already_posted(sess.agent.messages, job.id) or _already_posted(sess.pending_job_notices, job.id):
        return
    if sess.busy:
        sess.pending_job_notices.append(notice)
        return
    sess.agent.messages.append(notice)
    sess.updated_at = time.time()
    try:
        STORE.persist(sid)
    except Exception as exc:
        log_exception(_log, f"persist job done notice failed for {sid}", exc)
