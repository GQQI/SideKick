"""In-memory chat sessions for the API layer (+ disk history)."""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from ..runtime.agent import Agent
from ..core.config import Settings, get_settings, reload_settings
from ..core.events import EventBus, new_id
from ..core.logutil import get_logger, log_exception
from .session import load_session, save_session, sessions_dir

_log = get_logger("metateam.store")

@dataclass
class ChatSession:
    id: str
    agent: Agent
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    title: str = "New chat"
    user_id: str = ""
    busy: bool = False


_UNTITLED_TITLES = frozenset({"新会话", "New chat", "Untitled", ""})

_TITLE_SYSTEM = """你是会话标题助手。根据用户第一条指令，写一个简短标题。
规则：中文 6–18 字，或英文 3–8 个词；不要引号；不要句号；只输出标题本身。"""


def is_untitled_session(title: str) -> bool:
    return (title or "").strip() in _UNTITLED_TITLES


def _is_internal_message(m: dict[str, Any]) -> bool:
    """Hide Sidekick-injected prompts (plan steps, etc.) from the UI transcript."""
    if m.get("sidekick_internal") or m.get("internal"):
        return True
    meta = m.get("sidekick")
    if isinstance(meta, dict) and meta.get("internal"):
        return True
    content = str(m.get("content") or "").lstrip()
    return content.startswith("[Plan step ") or content.startswith("[sidekick:")


def _message_display_text(m: dict[str, Any]) -> str:
    """Prefer UI display text (e.g. /skill name) over the raw model prompt."""
    meta = m.get("sidekick")
    if isinstance(meta, dict):
        display = str(meta.get("display") or "").strip()
        if display:
            return display
    return str(m.get("content") or "")


def _extract_skill_title_source(content: str) -> str:
    """Pull a human-readable task out of skill invocation prompts."""
    text = (content or "").strip()
    if not text:
        return ""
    # /skill name [task]
    m = re.match(r"^/skill\s+(\S+)(?:\s+(.+))?$", text, re.I | re.S)
    if m:
        name, task = m.group(1), (m.group(2) or "").strip()
        return task or f"Skill · {name}"
    # New short tool-call instruction
    m = re.search(
        r"请立即调用函数工具\s*`?(skill_[A-Za-z0-9_]+)`?"
        r"(?:，task 参数为：(.+?)(?:。|$))?",
        text,
        re.S,
    )
    if m:
        task = (m.group(2) or "").strip()
        if task and "可省略 task" not in task:
            return task
        tool = m.group(1) or "skill"
        return f"Skill · {tool.removeprefix('skill_').replace('_', '-')}"
    # Legacy inject blob
    if "【Skill 已注入】" in text or "----- SKILL START -----" in text:
        m = re.search(r"【Skill 已注入】\s*([^\n]+)", text)
        name = (m.group(1).strip() if m else "skill")
        m = re.search(
            r"用户本次附加指令：\s*\n(.+?)(?:\n\n请按该 Skill|\Z)",
            text,
            re.S,
        )
        if m and m.group(1).strip():
            return m.group(1).strip()
        return f"Skill · {name}"
    return ""


def _is_skill_or_command_message(content: str) -> bool:
    text = (content or "").strip()
    if not text:
        return True
    if text.startswith("【Skill 已注入】") or "----- SKILL START -----" in text:
        return True
    if text.startswith("请立即调用函数工具"):
        return True
    if re.match(r"^/skill\b", text, re.I):
        return True
    if text.startswith("/") or text.startswith("／"):
        return True
    return False


def _title_source_text(content: str) -> str:
    """Normalize user text into something suitable for a chat title."""
    skill = _extract_skill_title_source(content)
    if skill:
        return skill
    text = (content or "").strip()
    if not text or _is_skill_or_command_message(text):
        return ""
    return text


def _summarize_title(content: str, limit: int = 20) -> str:
    """Heuristic first-line summary of the first real user turn."""
    text = _title_source_text(content)
    if not text:
        return ""
    line = text.splitlines()[0].strip()
    line = " ".join(line.split())
    if len(line) > limit:
        return line[:limit]
    return line


def generate_session_title(llm: Any, content: str, *, display: str = "") -> str:
    """LLM title from the first user instruction; falls back to heuristic."""
    source = _title_source_text(display or content) or _title_source_text(content)
    if not source:
        return ""
    # Short enough already — skip an extra model call.
    compact = " ".join(source.split())
    if len(compact) <= 18:
        return compact
    try:
        raw = llm.complete_text(
            _TITLE_SYSTEM,
            f"用户第一条指令：\n{source[:800]}\n\n标题：",
            temperature=0.2,
        )
    except Exception as exc:
        log_exception(_log, "generate_session_title LLM failed", exc)
        return _summarize_title(source, limit=18)
    title = (raw or "").strip().strip("\"'“”‘’").splitlines()[0].strip()
    title = re.sub(r"^[标题Title：:\s]+", "", title)
    if not title or is_untitled_session(title):
        return _summarize_title(source, limit=18)
    if len(title) > 24:
        title = title[:24]
    return title


def _title_from_messages(messages: list[dict[str, Any]], fallback: str = "New chat") -> str:
    for m in messages:
        if m.get("role") != "user" or _is_internal_message(m):
            continue
        title = _summarize_title(_message_display_text(m))
        if title:
            return title
    return fallback


def _prefer_title(*candidates: str, fallback: str = "New chat") -> str:
    for c in candidates:
        t = (c or "").strip()
        if t and not is_untitled_session(t):
            return t
    return fallback


class SessionStore:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._lock = threading.Lock()
        self._sessions: dict[str, ChatSession] = {}

    def refresh_settings(
        self,
        *,
        rebind_llm: bool = True,
        rebind_workspace: bool = False,
        user_id: str | None = None,
    ) -> Settings:
        """Reload model config and optionally rebind live agents.

        ``user_id`` limits which sessions are touched (current tenant).
        Workspace is copied onto those sessions only when ``rebind_workspace``
        is True, so saving a model does not yank another chat onto a new folder.
        """
        self.settings = reload_settings() if rebind_llm else get_settings()
        from ..runtime.llm import LLM
        from ..services.skills import load_skills
        from .model_config import apply_to_settings, load_model_config
        from .tenant_context import apply_knowledge_to_settings, get_user_id

        cfg = load_model_config()
        uid = user_id if user_id is not None else get_user_id()
        with self._lock:
            sessions = [
                s
                for s in self._sessions.values()
                if not uid or s.user_id == uid or not s.user_id
            ]
        live_ws = getattr(self.settings, "workspace", None)
        live_skills = getattr(self.settings, "skills_dir", None)
        live_memory = getattr(self.settings, "memory_file", None)
        for sess in sessions:
            try:
                apply_to_settings(sess.agent.settings, cfg)
                apply_knowledge_to_settings(sess.agent.settings, uid)
                if rebind_workspace and live_ws is not None:
                    sess.agent.settings.workspace = live_ws
                    if live_skills is not None:
                        prev_skills = sess.agent.settings.skills_dir
                        sess.agent.settings.skills_dir = live_skills
                        if live_memory is not None:
                            sess.agent.settings.memory_file = live_memory
                        if prev_skills != live_skills:
                            sess.agent.skills = load_skills(live_skills)
                    try:
                        sess.agent._refresh_workspace_grounding()
                    except Exception as exc:
                        log_exception(_log, f"workspace grounding failed for {sess.id}", exc)
                if not rebind_llm:
                    continue
                sess.agent.llm = LLM(sess.agent.settings)
                sess.agent.compress_llm = LLM(
                    sess.agent.settings,
                    model=sess.agent.settings.compress_model,
                    api_key=getattr(sess.agent.settings, "compress_api_key", None)
                    or sess.agent.settings.api_key,
                    base_url=getattr(sess.agent.settings, "compress_base_url", None)
                    or sess.agent.settings.base_url,
                )
            except Exception as exc:
                log_exception(_log, f"refresh_settings failed for session {sess.id}", exc)
        return self.settings

    def create(self) -> ChatSession:
        # Always use latest settings for new chats (model switch)
        from .tenant_context import get_user_id

        self.settings = get_settings()
        bus = EventBus()
        from ..runtime.approval import ApprovalGate

        agent = Agent(self.settings, bus=bus, approval=ApprovalGate())
        sess = ChatSession(id=new_id("sess"), agent=agent, user_id=get_user_id())
        agent.session_id = sess.id
        with self._lock:
            self._sessions[sess.id] = sess
        return sess

    def decide_approval(
        self,
        session_id: str,
        approval_id: str,
        approved: bool,
        *,
        remember: bool = False,
        patch_args: Optional[dict[str, Any]] = None,
    ) -> bool:
        sess = self.get(session_id)
        if not sess:
            return False
        return sess.agent.approval.decide(
            approval_id, approved, remember=remember, patch_args=patch_args
        )

    def answer_ask(
        self,
        session_id: str,
        ask_id: str,
        *,
        choice: str,
        text: str = "",
        option_label: str = "",
    ) -> bool:
        sess = self.get(session_id)
        if not sess:
            return False
        return sess.agent.ask.answer(
            ask_id,
            choice=choice,
            text=text,
            option_label=option_label,
        )

    def decide_plan(
        self,
        session_id: str,
        plan_id: str,
        approved: bool,
        *,
        summary: Optional[str] = None,
        tasks: Optional[list[dict[str, Any]]] = None,
    ) -> bool:
        sess = self.get(session_id)
        if not sess:
            return False
        return sess.agent.plan_gate.decide(
            plan_id, approved, summary=summary, tasks=tasks
        )

    def runtime_snapshot(self, sess: ChatSession) -> dict[str, Any]:
        agent = sess.agent
        return {
            "busy": bool(sess.busy),
            "pending_approvals": agent.approval.pending(),
            "pending_asks": agent.ask.pending(),
            "pending_plans": agent.plan_gate.pending(),
        }

    def _get_live(self, session_id: str) -> Optional[ChatSession]:
        """Lookup in-memory session without ContextVar ownership checks.

        Chat SSE workers run on threads that do not inherit request ContextVars;
        persist/checkpoint must still find the live session by id.
        """
        with self._lock:
            return self._sessions.get(session_id)

    def get(self, session_id: str) -> Optional[ChatSession]:
        from .tenant_context import get_user_id

        uid = get_user_id()
        with self._lock:
            hit = self._sessions.get(session_id)
        if hit:
            if hit.user_id and hit.user_id != uid:
                return None
            return hit
        return self._restore_from_disk(session_id)

    def stop(self, session_id: str) -> bool:
        sess = self.get(session_id) or self._get_live(session_id)
        if not sess:
            return False
        sess.agent.request_cancel()
        return True

    def _migrate_orphan_sessions(self, uid: str) -> None:
        """Copy legacy/orphan sess_*.json into the current user's tenant folder once."""
        import json
        from pathlib import Path

        from ..core.config import REPO_ROOT
        from .session import legacy_sessions_dir

        dest = sessions_dir(self.settings.root, uid)
        roots = [
            legacy_sessions_dir(self.settings.root),
            REPO_ROOT / "backend" / "sessions",
        ]
        for root in roots:
            if not root.is_dir():
                continue
            for path in root.glob("sess_*.json"):
                target = dest / path.name
                if target.exists():
                    continue
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(data, dict):
                        continue
                    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
                    owner = str(meta.get("user_id") or "").strip()
                    # Adopt unowned orphans; skip files clearly owned by someone else.
                    if owner and owner != uid:
                        continue
                    meta["user_id"] = uid
                    data["meta"] = meta
                    target.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except Exception as exc:
                    log_exception(_log, f"orphan session migrate failed for {path}", exc)

    def _session_paths_for_user(self) -> list[Any]:
        from .session import legacy_sessions_dir
        from .tenant_context import DEFAULT_USER_ID, get_user_id

        uid = get_user_id()
        try:
            self._migrate_orphan_sessions(uid)
        except Exception as exc:
            log_exception(_log, "orphan session migrate sweep failed", exc)
        paths: list[Any] = list(sessions_dir(self.settings.root, uid).glob("*.json"))
        # Pre-setup / default: also surface leftover flat sessions
        if uid == DEFAULT_USER_ID:
            for path in legacy_sessions_dir(self.settings.root).glob("sess_*.json"):
                paths.append(path)
        return paths

    def _restore_from_disk(self, session_id: str) -> Optional[ChatSession]:
        from ..core.config import REPO_ROOT
        from .tenant_context import get_user_id

        uid = get_user_id()
        candidates = [
            sessions_dir(self.settings.root, uid) / f"{session_id}.json",
        ]
        from .session import legacy_sessions_dir
        from .tenant_context import DEFAULT_USER_ID

        if uid == DEFAULT_USER_ID:
            candidates.append(legacy_sessions_dir(self.settings.root) / f"{session_id}.json")
            candidates.append(REPO_ROOT / "backend" / "sessions" / f"{session_id}.json")

        path = next((p for p in candidates if p.exists()), None)
        if not path:
            return None
        try:
            meta, messages = load_session(path)
        except Exception:
            return None
        if meta.user_id and meta.user_id != uid:
            return None
        self.settings = get_settings()
        bus = EventBus()
        agent = Agent(self.settings, bus=bus, messages=messages)
        mtime = path.stat().st_mtime
        title = _prefer_title(meta.title, _title_from_messages(messages, ""), fallback=meta.id)
        sess = ChatSession(
            id=meta.id or session_id,
            agent=agent,
            created_at=mtime,
            updated_at=mtime,
            title=title,
            user_id=meta.user_id or uid,
        )
        agent.session_id = sess.id
        with self._lock:
            self._sessions[sess.id] = sess
        return sess

    def list(self, *, page: int = 1, page_size: int = 20) -> dict[str, Any]:
        from .tenant_context import get_user_id

        uid = get_user_id()
        items: dict[str, dict[str, Any]] = {}

        # Disk history first
        for path in self._session_paths_for_user():
            try:
                meta, messages = load_session(path)
                if meta.user_id and meta.user_id != uid:
                    continue
                sid = meta.id or path.stem
                user_count = sum(
                    1
                    for m in messages
                    if m.get("role") == "user" and not _is_internal_message(m)
                )
                mtime = path.stat().st_mtime
                updated = mtime
                if meta.updated_at:
                    try:
                        from datetime import datetime

                        updated = max(
                            mtime,
                            datetime.fromisoformat(meta.updated_at.replace("Z", "+00:00")).timestamp(),
                        )
                    except ValueError:
                        pass
                created = path.stat().st_ctime
                if meta.created_at:
                    try:
                        from datetime import datetime

                        created = datetime.fromisoformat(
                            meta.created_at.replace("Z", "+00:00")
                        ).timestamp()
                    except ValueError:
                        pass
                items[sid] = {
                    "id": sid,
                    "title": _prefer_title(
                        meta.title,
                        _title_from_messages(messages, ""),
                        fallback=sid,
                    ),
                    "created_at": created,
                    "updated_at": updated,
                    "messages": len(messages),
                    "user_turns": user_count,
                    "demo": False,
                    "source": "disk",
                }
            except Exception:
                continue

        with self._lock:
            live = list(self._sessions.values())
        for s in live:
            if s.user_id and s.user_id != uid:
                continue
            prev = items.get(s.id)
            # Prefer the freshest interaction time (memory vs disk)
            updated = s.updated_at
            if prev and float(prev.get("updated_at") or 0) > updated:
                updated = float(prev["updated_at"])
            items[s.id] = {
                "id": s.id,
                "title": _prefer_title(
                    s.title,
                    _title_from_messages(s.agent.messages, ""),
                    fallback=s.id,
                ),
                "created_at": s.created_at,
                "updated_at": updated,
                "messages": len(s.agent.messages),
                "user_turns": sum(
                    1
                    for m in s.agent.messages
                    if m.get("role") == "user" and not _is_internal_message(m)
                ),
                "demo": s.agent.settings.demo_mode,
                "source": "memory",
            }

        all_items = sorted(
            items.values(),
            key=lambda x: float(x.get("updated_at") or 0),
            reverse=True,
        )
        total = len(all_items)
        page = max(1, int(page or 1))
        page_size = max(1, min(100, int(page_size or 20)))
        total_pages = max(1, (total + page_size - 1) // page_size) if total else 1
        if page > total_pages:
            page = total_pages
        start = (page - 1) * page_size
        chunk = all_items[start : start + page_size]
        return {
            "items": chunk,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        }

    def delete(self, session_id: str) -> bool:
        from ..core.config import REPO_ROOT
        from .session import legacy_sessions_dir
        from .tenant_context import DEFAULT_USER_ID, get_user_id

        uid = get_user_id()
        removed = False
        with self._lock:
            hit = self._sessions.get(session_id)
            if hit and hit.user_id and hit.user_id != uid:
                return False
            if session_id in self._sessions:
                del self._sessions[session_id]
                removed = True
        candidates = [sessions_dir(self.settings.root, uid) / f"{session_id}.json"]
        if uid == DEFAULT_USER_ID:
            candidates.append(legacy_sessions_dir(self.settings.root) / f"{session_id}.json")
            candidates.append(REPO_ROOT / "backend" / "sessions" / f"{session_id}.json")
        for path in candidates:
            if path.exists():
                try:
                    path.unlink()
                    removed = True
                except OSError:
                    pass
        return removed

    def truncate_before_user_turn(self, session_id: str, keep_user_turns: int) -> bool:
        """Keep the first `keep_user_turns` user messages; drop that turn and everything after."""
        sess = self.get(session_id)
        if not sess:
            return False
        if keep_user_turns < 0:
            raise ValueError("keep_user_turns must be >= 0")
        msgs = sess.agent.messages
        count = 0
        cut = len(msgs)
        for i, m in enumerate(msgs):
            if m.get("role") == "user" and not _is_internal_message(m):
                if count == keep_user_turns:
                    cut = i
                    break
                count += 1
        sess.agent.messages = msgs[:cut]
        sess.updated_at = time.time()
        try:
            self.persist(session_id)
        except Exception as exc:
            log_exception(_log, f"persist after truncate failed for {session_id}", exc)
        return True

    def persist(self, session_id: str) -> Optional[str]:
        # Prefer live map — worker threads may not have the request ContextVar.
        sess = self._get_live(session_id) or self.get(session_id)
        if not sess:
            _log.error("persist skipped: session %s not found", session_id)
            return None
        path = save_session(
            self.settings.root,
            sess.agent.messages,
            model=self.settings.model,
            workspace=self.settings.workspace,
            session_id=session_id,
            user_id=sess.user_id or None,
            title=sess.title or "",
        )
        return str(path)

    def ui_messages(self, sess: ChatSession) -> list[dict[str, Any]]:
        """User-facing transcript including assistant text and tool cards.

        Internal plan-step prompts / system noise are omitted. Tool calls are
        paired with their results so history restore matches the live thread.
        """
        import json as _json

        msgs = sess.agent.messages
        results_by_id: dict[str, dict[str, Any]] = {}
        for m in msgs:
            if m.get("role") != "tool":
                continue
            cid = str(m.get("tool_call_id") or "").strip()
            if cid:
                results_by_id[cid] = m

        out: list[dict[str, Any]] = []
        emitted_tool_ids: set[str] = set()

        for m in msgs:
            role = m.get("role")
            if role == "user":
                if _is_internal_message(m):
                    continue
                content = _message_display_text(m).strip()
                if content and not content.startswith("Iteration budget exhausted"):
                    out.append({"role": "user", "content": content})
                continue

            if role == "assistant":
                if _is_internal_message(m):
                    continue
                content = str(m.get("content") or "").strip()
                if content:
                    item: dict[str, Any] = {"role": "assistant", "content": content}
                    reasoning = str(m.get("reasoning") or "").strip()
                    if reasoning:
                        item["reasoning"] = reasoning
                    out.append(item)

                for tc in m.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                    call_id = str(tc.get("id") or "").strip()
                    name = str((fn or {}).get("name") or "tool")
                    args_raw = (fn or {}).get("arguments") or "{}"
                    args: Any
                    if isinstance(args_raw, dict):
                        args = args_raw
                    else:
                        try:
                            parsed = _json.loads(str(args_raw))
                            args = parsed if isinstance(parsed, dict) else {"_raw": str(args_raw)}
                        except Exception:
                            args = {"_raw": str(args_raw)}
                    result_msg = results_by_id.get(call_id) if call_id else None
                    result = str((result_msg or {}).get("content") or "")
                    if result.startswith("ERROR"):
                        status = "error"
                    elif result_msg is not None:
                        status = "done"
                    else:
                        status = "done"
                    tool_item = {
                        "role": "tool",
                        "name": name,
                        "call_id": call_id or new_id("call"),
                        "args": args,
                        "result": result,
                        "status": status,
                    }
                    out.append(tool_item)
                    if call_id:
                        emitted_tool_ids.add(call_id)
                continue

            # Orphan tool rows (no matching assistant tool_calls) — still show them.
            if role == "tool":
                cid = str(m.get("tool_call_id") or "").strip()
                if cid and cid in emitted_tool_ids:
                    continue
                result = str(m.get("content") or "")
                out.append(
                    {
                        "role": "tool",
                        "name": str(m.get("name") or "tool"),
                        "call_id": cid or new_id("call"),
                        "args": {},
                        "result": result,
                        "status": "error" if result.startswith("ERROR") else "done",
                    }
                )
                if cid:
                    emitted_tool_ids.add(cid)

        return out


STORE = SessionStore()
