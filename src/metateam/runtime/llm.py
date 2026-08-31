"""OpenAI-compatible client (DeepSeek-ready) + demo stub."""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable, Iterator, Optional

from openai import OpenAI

from .think_tags import ThinkTagSplitter, split_think_tags
from .text_tool_calls import (
    XmlToolStream,
    merge_text_tool_calls,
    split_before_tool_markup,
)
from ..core.config import Settings


def _is_tool_choice_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return (
        "enable-auto-tool-choice" in msg
        or "tool-call-parser" in msg
        or '"auto" tool choice' in msg
        or "auto tool choice" in msg
    )


def _retry_kwargs_for_exc(kwargs: dict[str, Any], exc: BaseException) -> dict[str, Any] | None:
    msg = str(exc).lower()
    retry = dict(kwargs)
    changed = False
    if _is_tool_choice_error(exc):
        if "tools" in retry or "tool_choice" in retry:
            retry.pop("tools", None)
            retry.pop("tool_choice", None)
            changed = True
    if "thinking" in msg or "reasoning" in msg or "extra_body" in msg:
        if "extra_body" in retry or "reasoning_effort" in retry:
            retry.pop("extra_body", None)
            retry.pop("reasoning_effort", None)
            changed = True
    if "stream_options" in msg or "include_usage" in msg:
        if "stream_options" in retry:
            retry.pop("stream_options", None)
            changed = True
    return retry if changed else None


def _stream_timeouts(settings: Any) -> tuple[float, float]:
    idle = float(getattr(settings, "llm_idle_timeout", 0) or 0)
    total = float(getattr(settings, "llm_stream_timeout", 0) or 0)
    return max(0.0, idle), max(0.0, total)


class StreamWatchdog:
    """Close a hung provider stream when idle or over a hard duration."""

    def __init__(
        self,
        close_fn: Callable[[], None],
        *,
        idle_sec: float,
        max_sec: float,
    ) -> None:
        self._close = close_fn
        self.idle_sec = max(0.0, float(idle_sec or 0))
        self.max_sec = max(0.0, float(max_sec or 0))
        now = time.monotonic()
        self._last = now
        self._start = now
        self._stop = threading.Event()
        self.reason = ""
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self.idle_sec <= 0 and self.max_sec <= 0:
            return
        self._thread = threading.Thread(
            target=self._run, name="llm-stall-watch", daemon=True
        )
        self._thread.start()

    def bump(self) -> None:
        self._last = time.monotonic()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive() and threading.current_thread() is not t:
            t.join(timeout=1.0)

    def _fire(self, reason: str) -> None:
        if self.reason or self._stop.is_set():
            return
        self.reason = reason
        try:
            self._close()
        except Exception:
            pass

    def _run(self) -> None:
        while not self._stop.wait(0.4):
            now = time.monotonic()
            if self.idle_sec > 0 and now - self._last >= self.idle_sec:
                self._fire("idle")
                return
            if self.max_sec > 0 and now - self._start >= self.max_sec:
                self._fire("max")
                return


class LLM:
    def __init__(
        self,
        settings: Settings,
        model: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_tokens: Optional[int] = None,
    ):
        self.settings = settings
        self.model = model or settings.model
        self.max_tokens = int(
            max_tokens if max_tokens is not None else getattr(settings, "max_tokens", 0) or 0
        )
        key = (api_key if api_key is not None else settings.api_key) or ""
        url = (base_url if base_url is not None else settings.base_url) or settings.base_url
        self.demo = settings.demo_mode and not key.strip()
        if key.strip():
            self.demo = False
        self.client: OpenAI | None = None
        self._active_stream: Any = None
        self._disable_tools = False
        if not self.demo:
            if not key.strip():
                raise RuntimeError("API key empty — configure in UI or META_DEMO_MODE=1")
            self.client = OpenAI(api_key=key, base_url=url.rstrip("/"))

    def close_active_stream(self) -> None:
        """Best-effort close of the in-flight OpenAI stream (interrupts provider read)."""
        stream = self._active_stream
        self._active_stream = None
        if stream is None:
            return
        for closer in (
            getattr(stream, "close", None),
            getattr(getattr(stream, "response", None), "close", None),
            getattr(getattr(stream, "http_response", None), "close", None),
        ):
            if callable(closer):
                try:
                    closer()
                except Exception:
                    pass

    def _call_kwargs(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]],
        temperature: float,
        stream: bool = False,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": _strip_for_api(messages),
            "temperature": temperature,
            "stream": stream,
        }
        if tools and not self._disable_tools:
            kwargs["tools"] = tools
            # Do not send tool_choice="auto": vLLM 400s unless the server was
            # started with --enable-auto-tool-choice --tool-call-parser.

        mt = int(getattr(self, "max_tokens", 0) or getattr(self.settings, "max_tokens", 0) or 0)
        if mt > 0:
            kwargs["max_tokens"] = mt

        # DeepSeek / reasoning models
        effort = getattr(self.settings, "reasoning_effort", None)
        if effort:
            kwargs["reasoning_effort"] = effort

        extra: dict[str, Any] = {}
        if getattr(self.settings, "thinking_enabled", False):
            extra["thinking"] = {"type": "enabled"}
        if extra:
            kwargs["extra_body"] = extra
        return kwargs

    def _create(self, kwargs: dict[str, Any]) -> Any:
        assert self.client is not None
        pending = dict(kwargs)
        _, stream_cap = _stream_timeouts(self.settings)
        if stream_cap > 0 and "timeout" not in pending:
            pending["timeout"] = stream_cap
        last: BaseException | None = None
        for _ in range(4):
            try:
                return self.client.chat.completions.create(**pending)
            except TypeError as exc:
                last = exc
                pending.pop("reasoning_effort", None)
                pending.pop("stream_options", None)
                pending.pop("timeout", None)
                continue
            except Exception as exc:
                last = exc
                retry = _retry_kwargs_for_exc(pending, exc)
                if retry is None:
                    raise
                if _is_tool_choice_error(exc):
                    self._disable_tools = True
                pending = retry
        assert last is not None
        raise last

    def chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        temperature: Optional[float] = None,
    ) -> dict[str, Any]:
        if self.demo:
            return _demo_chat(messages, tools)

        assert self.client is not None
        temp = self.settings.temperature if temperature is None else temperature
        kwargs = self._call_kwargs(messages, tools, temp, stream=False)
        # create() doesn't take stream=False as needed if we pop it
        kwargs.pop("stream", None)
        resp = self._create(kwargs)

        msg = resp.choices[0].message
        content = extract_content_text(msg)
        reasoning = extract_reasoning_text(msg)
        content, tagged = split_think_tags(content)
        # Native reasoning already present → do not append tagged duplicates
        if tagged and not reasoning:
            reasoning = tagged

        out: dict[str, Any] = {"role": "assistant", "content": content}
        if reasoning:
            out["reasoning"] = reasoning
        if msg.tool_calls:
            out["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments or "{}",
                    },
                }
                for tc in msg.tool_calls
            ]
        return merge_text_tool_calls(out)

    def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        temperature: Optional[float] = None,
        cancel_check: Optional[Any] = None,
    ) -> Iterator[tuple[str, Any]]:
        """Yield ("delta", text) then a final ("done", assistant_message)."""
        if self.demo:
            msg = _demo_chat(messages, tools)
            text = msg.get("content") or ""
            for i in range(0, len(text), 12):
                if callable(cancel_check) and cancel_check():
                    break
                yield ("delta", text[i : i + 12])
            yield ("done", msg)
            return

        assert self.client is not None
        temp = self.settings.temperature if temperature is None else temperature
        kwargs = self._call_kwargs(messages, tools, temp, stream=True)
        stream = self._create(kwargs)

        self._active_stream = stream
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_acc: dict[int, dict[str, str]] = {}
        cancelled = False
        xml_hold = ""
        xml_tools = XmlToolStream()
        # Stateful splitter for <think>…</think> embedded in content stream
        tag_split = ThinkTagSplitter()
        idle_sec, max_sec = _stream_timeouts(self.settings)
        watch = StreamWatchdog(
            self.close_active_stream, idle_sec=idle_sec, max_sec=max_sec
        )
        watch.start()

        try:
            for chunk in stream:
                watch.bump()
                if callable(cancel_check) and cancel_check():
                    cancelled = True
                    break
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if not delta:
                    continue

                # 1) Native reasoning_content / reasoning fields
                reasoning_piece = extract_reasoning_text(delta)
                if reasoning_piece:
                    reasoning_parts.append(reasoning_piece)
                    yield ("reasoning_delta", reasoning_piece)

                # 2) Visible content, with <think> tags peeled into reasoning.
                # If this delta already carried native reasoning, only emit
                # visible content — do not also treat tagged content as
                # reasoning (avoids NowNow / let let duplication).
                content_piece = extract_content_text(delta)
                if content_piece:
                    for kind, piece in tag_split.feed(content_piece):
                        if not piece:
                            continue
                        if kind == "reasoning":
                            if reasoning_piece:
                                continue
                            reasoning_parts.append(piece)
                            yield ("reasoning_delta", piece)
                        else:
                            visible, xml_hold = split_before_tool_markup(xml_hold + piece)
                            if visible:
                                content_parts.append(visible)
                                yield ("delta", visible)
                            if not tool_acc:
                                for payload in xml_tools.feed(xml_hold):
                                    yield ("tool_delta", payload)

                for tc in getattr(delta, "tool_calls", None) or []:
                    idx = int(getattr(tc, "index", 0) or 0)
                    slot = tool_acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                    changed = False
                    if getattr(tc, "id", None):
                        slot["id"] = tc.id
                        changed = True
                    fn = getattr(tc, "function", None)
                    arg_piece = ""
                    if fn is not None:
                        if getattr(fn, "name", None):
                            slot["name"] = (slot["name"] or "") + str(fn.name)
                            changed = True
                        if getattr(fn, "arguments", None):
                            arg_piece = str(fn.arguments)
                            slot["arguments"] = (slot["arguments"] or "") + arg_piece
                            changed = True
                    if changed:
                        yield (
                            "tool_delta",
                            {
                                "index": idx,
                                "id": slot.get("id") or "",
                                "name": slot.get("name") or "",
                                "arguments_delta": arg_piece,
                                "arguments": slot.get("arguments") or "",
                            },
                        )
        except Exception:
            if not watch.reason and not cancelled and not (
                callable(cancel_check) and cancel_check()
            ):
                watch.stop()
                raise
        finally:
            watch.stop()
            if self._active_stream is stream:
                self._active_stream = None
            for closer in (
                getattr(stream, "close", None),
                getattr(getattr(stream, "response", None), "close", None),
                getattr(getattr(stream, "http_response", None), "close", None),
            ):
                if callable(closer):
                    try:
                        closer()
                    except Exception:
                        pass

        for kind, piece in tag_split.flush():
            if not piece:
                continue
            if kind == "reasoning":
                reasoning_parts.append(piece)
                yield ("reasoning_delta", piece)
            else:
                visible, xml_hold = split_before_tool_markup(xml_hold + piece)
                if visible:
                    content_parts.append(visible)
                    yield ("delta", visible)

        if not tool_acc:
            for payload in xml_tools.feed(xml_hold):
                yield ("tool_delta", payload)

        content = "".join(content_parts) + xml_hold
        reasoning = "".join(reasoning_parts)
        out: dict[str, Any] = {"role": "assistant", "content": content}
        if reasoning:
            out["reasoning"] = reasoning
        if tool_acc and not cancelled:
            out["tool_calls"] = [
                {
                    "id": tool_acc[i].get("id") or f"call_{i}",
                    "type": "function",
                    "function": {
                        "name": tool_acc[i].get("name") or "",
                        "arguments": tool_acc[i].get("arguments") or "{}",
                    },
                }
                for i in sorted(tool_acc)
                if tool_acc[i].get("name")
            ]
        if watch.reason and not cancelled:
            yield (
                "stalled",
                {
                    "reason": watch.reason,
                    "idle_sec": idle_sec,
                    "max_sec": max_sec,
                },
            )
        yield ("done", merge_text_tool_calls(out, id_prefix=xml_tools.prefix))

    def stream_text(
        self,
        messages: list[dict[str, Any]],
        temperature: Optional[float] = None,
        cancel_check: Optional[Any] = None,
    ) -> Iterator[str]:
        for kind, payload in self.stream_chat(
            messages, tools=None, temperature=temperature, cancel_check=cancel_check
        ):
            if kind == "delta":
                yield str(payload)

    def complete_text(self, system: str, user: str, temperature: float = 0.1) -> str:
        msg = self.chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            tools=None,
            temperature=temperature,
        )
        return (msg.get("content") or "").strip()


def extract_content_text(msg: Any) -> str:
    """Visible assistant content only (never reasoning/thinking)."""
    if msg is None:
        return ""
    content = getattr(msg, "content", None)
    if isinstance(content, str) and content:
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                # Skip explicit thinking parts in content arrays
                ptype = str(p.get("type") or "")
                if ptype in {"thinking", "reasoning", "reasoning_content"}:
                    continue
                if p.get("text"):
                    parts.append(str(p["text"]))
            else:
                ptype = str(getattr(p, "type", "") or "")
                if ptype in {"thinking", "reasoning", "reasoning_content"}:
                    continue
                t = getattr(p, "text", None)
                if t:
                    parts.append(str(t))
        return "".join(parts)
    return ""


def extract_reasoning_text(msg: Any) -> str:
    """Model thinking / reasoning stream pieces only.

    Providers often expose the same chunk on multiple fields
    (e.g. reasoning_content + model_extra['reasoning_content']).
    Take the first non-empty source only — never concatenate duplicates.
    """
    if msg is None:
        return ""

    def _as_text(v: Any) -> str:
        if isinstance(v, str) and v:
            return v
        return ""

    for attr in ("reasoning_content", "reasoning", "thinking"):
        text = _as_text(getattr(msg, attr, None))
        if text:
            return text

    content = getattr(msg, "content", None)
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict):
                ptype = str(p.get("type") or "")
                if ptype in {"thinking", "reasoning", "reasoning_content"} and p.get("text"):
                    parts.append(str(p["text"]))
            else:
                ptype = str(getattr(p, "type", "") or "")
                if ptype in {"thinking", "reasoning", "reasoning_content"}:
                    t = getattr(p, "text", None)
                    if t:
                        parts.append(str(t))
        if parts:
            return "".join(parts)

    extra = getattr(msg, "model_extra", None)
    if isinstance(extra, dict):
        for k in ("reasoning_content", "reasoning", "thinking"):
            text = _as_text(extra.get(k))
            if text:
                return text
    return ""


def extract_message_text(msg: Any) -> str:
    """Prefer visible content; do not fall back to reasoning (kept for compat)."""
    content = extract_content_text(msg)
    if content.strip():
        visible, _ = split_think_tags(content)
        return visible
    return ""


_PARTIAL_ARG_KEYS = (
    "goal",
    "task",
    "context",
    "role",
    "topic",
    "query",
    "prompt",
    "description",
    "path",
    "command",
    "content",
    "old_string",
    "new_string",
    "offset",
    "limit",
    "pattern",
)


def _unescape_json_fragment(text: str) -> str:
    return (
        (text or "")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace('\\"', '"')
        .replace("\\\\", "\\")
    )


def _loads_partial_object(raw: str) -> dict[str, Any] | None:
    text = (raw or "").strip()
    if not text:
        return None
    if not text.startswith("{"):
        found = re.search(r"\{.*", text, re.DOTALL)
        text = found.group(0) if found else text
    for extra in ("", "}", '"}', '"]}', '"]} }', '"}]}'):
        try:
            data = json.loads(text + extra)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            continue
    return None


def _salvage_tool_args(raw: str) -> dict[str, Any]:
    repaired = _loads_partial_object(raw)
    if repaired:
        return repaired
    out: dict[str, Any] = {}
    for key in _PARTIAL_ARG_KEYS:
        closed = re.search(
            rf'"{key}"\s*:\s*"((?:\\.|[^"\\])*)"',
            raw or "",
        )
        if closed:
            out[key] = _unescape_json_fragment(closed.group(1))
            continue
        opened = re.search(rf'"{key}"\s*:\s*"(.*)$', raw or "", re.DOTALL)
        if opened:
            out[key] = _unescape_json_fragment(opened.group(1).rstrip('"'))
    return out if out else {"_raw": raw}


def parse_tool_args(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw or "", re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(0))
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError:
                pass
        return _salvage_tool_args(raw or "")


def _strip_for_api(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        item = {
            k: v
            for k, v in m.items()
            if k in ("role", "content", "tool_calls", "tool_call_id", "name")
        }
        if item.get("role") == "assistant" and not item.get("content") and not item.get("tool_calls"):
            item["content"] = ""
        out.append(item)
    return out


def _demo_chat(
    messages: list[dict[str, Any]], tools: Optional[list[dict[str, Any]]]
) -> dict[str, Any]:
    last_user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = str(m.get("content") or "")
            break

    if messages and messages[-1].get("role") == "tool":
        content = str(messages[-1].get("content") or "")
        if "Function skill:" in content or content.lstrip().startswith("# Function skill"):
            return {
                "role": "assistant",
                "content": (
                    "【Demo】当前是 Demo 模式，不会真正按 Skill 执行写文件/改代码。\n\n"
                    "Skill 工具只返回了流程说明；请到「设置 → 模型」配置可用的 API Key，"
                    "确认顶栏不是 Demo，然后新建会话再执行 `/skill`。"
                ),
            }
        return {
            "role": "assistant",
            "content": (
                "【Demo】工具结果已收到（Demo 模式不会继续真实执行）。\n\n"
                f"{content[:280]}"
            ),
        }

    tool_names = set()
    if tools:
        for t in tools:
            fn = t.get("function") or {}
            tool_names.add(fn.get("name"))

    low = last_user.lower()

    # Prefer skill_* function tools
    skill_tools = [n for n in tool_names if n and str(n).startswith("skill_")]
    skill_asked = (
        "skill" in low
        or "技能" in last_user
        or "/skill" in low
        or "【skill" in low
        or any(str(n) in last_user for n in skill_tools)
    )
    if skill_asked and skill_tools:
        # Match the requested skill_* name from the user text when possible.
        name = next((n for n in skill_tools if n and str(n) in last_user), None)
        if not name:
            # /skill html-deck-editorial → skill_html_deck_editorial
            m = re.search(r"/skill\s+([A-Za-z0-9._-]+)", last_user, re.I)
            if m:
                want = "skill_" + re.sub(r"[^a-z0-9]+", "_", m.group(1).lower()).strip("_")
                name = next((n for n in skill_tools if n == want or want in str(n)), None)
        if not name:
            name = (
                "skill_hello_workspace"
                if "skill_hello_workspace" in skill_tools
                else skill_tools[0]
            )
        # Keep task short — never pass the whole SKILL injection blob as task.
        task = last_user.strip()
        if "用户本次附加指令" in task:
            m = re.search(r"用户本次附加指令：\s*\n(.+?)(?:\n\n请按该 Skill|\Z)", task, re.S)
            task = (m.group(1).strip() if m else "") or "按该 Skill 的标准流程执行"
        elif len(task) > 240:
            task = task[:240]
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "demo_sk_1",
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps({"task": task}, ensure_ascii=False),
                    },
                }
            ],
        }

    if "并行" in last_user or "delegate" in low:
        if "delegate_task" in tool_names:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "demo_del_1",
                        "type": "function",
                        "function": {
                            "name": "delegate_task",
                            "arguments": json.dumps(
                                {
                                    "tasks": [
                                        {"goal": "List workspace", "context": "list_dir ."},
                                        {
                                            "goal": "Use hello skill",
                                            "context": "call skill_hello_workspace",
                                        },
                                    ]
                                },
                                ensure_ascii=False,
                            ),
                        },
                    }
                ],
            }

    if any(k in last_user for k in ("列出", "list", "目录", "workspace")) and "list_dir" in tool_names:
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "demo_ls_1",
                    "type": "function",
                    "function": {"name": "list_dir", "arguments": json.dumps({"path": "."})},
                }
            ],
        }

    if ("写" in last_user or "write" in low or "hello" in low) and "write_file" in tool_names:
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "demo_w_1",
                    "type": "function",
                    "function": {
                        "name": "write_file",
                        "arguments": json.dumps(
                            {
                                "path": "notes/demo.md",
                                "content": "# Demo\n\nHello from Sidekick.\n",
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }

    return {
        "role": "assistant",
        "content": (
            "【Demo 模式】配置模型 API Key 后可使用真实推理。\n"
            "可试：列出 workspace / 调用 hello skill / 并行委派。"
        ),
    }
