"""Parse XML-style tool calls that models dump into assistant text.

MiniMax / Qwen / some vLLM setups emit markup instead of OpenAI tool_calls
when --tool-call-parser is missing or tool_choice=auto was stripped.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FUNC_BLOCK = re.compile(
    r"<function\s*=\s*([^>\s]+)\s*>(.*?)</function>",
    re.DOTALL | re.IGNORECASE,
)
_PARAM_EQ = re.compile(
    r"<parameter\s*=\s*([^>\s]+)\s*>(.*?)</parameter>",
    re.DOTALL | re.IGNORECASE,
)
_INVOKE_BLOCK = re.compile(
    r"<invoke\s+name=([^>]+)>(.*?)</invoke>",
    re.DOTALL | re.IGNORECASE,
)
_PARAM_NAME = re.compile(
    r"<parameter\s+name=([^>]+)>(.*?)</parameter>",
    re.DOTALL | re.IGNORECASE,
)
_JSON_TOOL = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL | re.IGNORECASE,
)
_WRAP_TAGS = re.compile(r"</?(?:minimax:)?tool_call>", re.IGNORECASE)
_OPENERS = (
    "<tool_call",
    "<minimax:tool_call",
    "<function=",
    "<invoke name=",
)


def _strip_quotes(raw: str) -> str:
    text = (raw or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1]
    return text


def _coerce_param(raw: str) -> Any:
    text = (raw or "").strip()
    if text.startswith("\n"):
        text = text[1:]
    if text.endswith("\n"):
        text = text[:-1]
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _call(name: str, args: dict[str, Any], idx: int) -> dict[str, Any]:
    return {
        "id": f"call_xml_{idx}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(args, ensure_ascii=False),
        },
    }


def extract_text_tool_calls(content: str) -> tuple[str, list[dict[str, Any]]]:
    """Return (visible_text, openai-style tool_calls) parsed from XML markup."""
    if not content:
        return content, []
    calls: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []

    def add(name: str, args: dict[str, Any], start: int, end: int) -> None:
        cleaned = _strip_quotes(name)
        if not cleaned:
            return
        calls.append(_call(cleaned, args, len(calls)))
        spans.append((start, end))

    for match in _FUNC_BLOCK.finditer(content):
        args = {
            _strip_quotes(pm.group(1)): _coerce_param(pm.group(2))
            for pm in _PARAM_EQ.finditer(match.group(2))
        }
        add(match.group(1), args, match.start(), match.end())

    for match in _INVOKE_BLOCK.finditer(content):
        args = {
            _strip_quotes(pm.group(1)): _coerce_param(pm.group(2))
            for pm in _PARAM_NAME.finditer(match.group(2))
        }
        add(match.group(1), args, match.start(), match.end())

    for match in _JSON_TOOL.finditer(content):
        try:
            data = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        name = data.get("name") or (data.get("function") or {}).get("name")
        args = data.get("arguments") or data.get("parameters") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"_raw": args}
        if name and isinstance(args, dict):
            add(str(name), args, match.start(), match.end())

    if not calls:
        dangling = re.search(
            r"<function\s*=\s*([^>\s]+)\s*>(.*)$",
            content,
            re.DOTALL | re.IGNORECASE,
        )
        if dangling:
            args = {
                _strip_quotes(pm.group(1)): _coerce_param(pm.group(2))
                for pm in _PARAM_EQ.finditer(dangling.group(2))
            }
            if args:
                add(dangling.group(1), args, dangling.start(), len(content))

    if not calls:
        return content, []

    visible = content
    for start, end in sorted(spans, reverse=True):
        visible = visible[:start] + visible[end:]
    visible = _WRAP_TAGS.sub("", visible).strip()
    return visible, calls


def split_before_tool_markup(text: str) -> tuple[str, str]:
    """Split visible prose from XML tool markup (including a partial opener)."""
    if not text:
        return "", ""
    low = text.lower()
    cut = -1
    for opener in _OPENERS:
        idx = low.find(opener)
        if idx != -1 and (cut == -1 or idx < cut):
            cut = idx
    if cut != -1:
        return text[:cut], text[cut:]
    last = text.rfind("<")
    if last != -1:
        tail = text[last:].lower()
        if any(opener.startswith(tail) for opener in _OPENERS):
            return text[:last], text[last:]
    return text, ""


_FUNC_OPEN = re.compile(r"<function\s*=\s*([^>\s]+)\s*>", re.IGNORECASE)
_INVOKE_OPEN = re.compile(
    r"<invoke\s+name=(['\"]?)([^>]+?)\1\s*>",
    re.IGNORECASE,
)
_PARAM_EQ_OPEN = re.compile(
    r"<parameter\s*=\s*([^>\s]+)\s*>(.*)$",
    re.DOTALL | re.IGNORECASE,
)
_PARAM_NAME_OPEN = re.compile(
    r"<parameter\s+name=(['\"]?)([^>]+?)\1\s*>(.*)$",
    re.DOTALL | re.IGNORECASE,
)
_JSON_OPEN = re.compile(r"<tool_call>\s*(\{)", re.IGNORECASE)


def _params_from_eq(body: str, *, tail: bool) -> dict[str, Any]:
    args: dict[str, Any] = {}
    last = 0
    for pm in _PARAM_EQ.finditer(body):
        args[_strip_quotes(pm.group(1))] = _coerce_param(pm.group(2))
        last = pm.end()
    if tail:
        open_p = _PARAM_EQ_OPEN.search(body[last:])
        if open_p:
            args[_strip_quotes(open_p.group(1))] = open_p.group(2)
    return args


def _params_from_name(body: str, *, tail: bool) -> dict[str, Any]:
    args: dict[str, Any] = {}
    last = 0
    for pm in _PARAM_NAME.finditer(body):
        args[_strip_quotes(pm.group(1))] = _coerce_param(pm.group(2))
        last = pm.end()
    if tail:
        open_p = _PARAM_NAME_OPEN.search(body[last:])
        if open_p:
            args[_strip_quotes(open_p.group(2))] = open_p.group(3)
    return args


def _partial_json_tool(blob: str) -> tuple[str, str] | None:
    name_m = re.search(r'"name"\s*:\s*"((?:\\.|[^"\\])*)"', blob)
    if not name_m:
        fn = re.search(
            r'"function"\s*:\s*\{[^}]*?"name"\s*:\s*"((?:\\.|[^"\\])*)"',
            blob,
            re.DOTALL,
        )
        if not fn:
            return None
        name = fn.group(1)
    else:
        name = name_m.group(1)
    args_m = re.search(r'"arguments"\s*:', blob)
    params_m = re.search(r'"parameters"\s*:', blob) if not args_m else None
    marker = args_m or params_m
    if not marker:
        return name, "{}"
    raw = blob[marker.end() :].strip()
    if raw.startswith("{"):
        return name, raw
    if raw.startswith('"'):
        return name, raw
    return name, raw or "{}"


def _parse_open_call(rest: str) -> tuple[str, dict[str, Any] | str] | None:
    fn = _FUNC_OPEN.search(rest)
    if fn:
        return _strip_quotes(fn.group(1)), _params_from_eq(rest[fn.end() :], tail=True)
    inv = _INVOKE_OPEN.search(rest)
    if inv:
        return _strip_quotes(inv.group(2)), _params_from_name(rest[inv.end() :], tail=True)
    json_open = _JSON_OPEN.search(rest)
    if json_open:
        parsed = _partial_json_tool(rest[json_open.start(1) :])
        if parsed:
            return parsed[0], parsed[1]
    fn_tail = re.search(r"<function\s*=\s*([^\s<>]+)\s*$", rest, re.IGNORECASE)
    if fn_tail:
        return _strip_quotes(fn_tail.group(1)), {}
    return None


def snapshot_xml_tool_calls(text: str) -> list[tuple[str, str]]:
    """Name + JSON arguments, including an in-progress trailing call."""
    if not (text or "").strip():
        return []
    spans: list[tuple[int, int, str, dict[str, Any] | str]] = []
    for match in _FUNC_BLOCK.finditer(text):
        spans.append(
            (
                match.start(),
                match.end(),
                _strip_quotes(match.group(1)),
                _params_from_eq(match.group(2), tail=False),
            )
        )
    for match in _INVOKE_BLOCK.finditer(text):
        spans.append(
            (
                match.start(),
                match.end(),
                _strip_quotes(match.group(1)),
                _params_from_name(match.group(2), tail=False),
            )
        )
    for match in _JSON_TOOL.finditer(text):
        parsed = _partial_json_tool(match.group(1))
        if parsed:
            spans.append((match.start(), match.end(), parsed[0], parsed[1]))
    last_end = max((s[1] for s in spans), default=0)
    open_call = _parse_open_call(text[last_end:])
    if open_call and open_call[0]:
        spans.append((last_end, len(text), open_call[0], open_call[1]))
    spans.sort(key=lambda s: s[0])
    out: list[tuple[str, str]] = []
    for _start, _end, name, args in spans:
        if not name:
            continue
        if isinstance(args, str):
            arg_s = args.strip() or "{}"
        else:
            arg_s = json.dumps(args, ensure_ascii=False)
        out.append((name, arg_s))
    return out


class XmlToolStream:
    """Turn growing XML markup into OpenAI-style tool_delta payloads."""

    def __init__(self) -> None:
        self._last: dict[int, tuple[str, str]] = {}

    def feed(self, held: str) -> list[dict[str, Any]]:
        snaps = snapshot_xml_tool_calls(held)
        out: list[dict[str, Any]] = []
        for i, (name, arguments) in enumerate(snaps):
            prev = self._last.get(i)
            if prev == (name, arguments):
                continue
            prev_args = prev[1] if prev else ""
            delta = (
                arguments[len(prev_args) :]
                if arguments.startswith(prev_args)
                else arguments
            )
            self._last[i] = (name, arguments)
            out.append(
                {
                    "index": i,
                    "id": f"call_xml_{i}",
                    "name": name,
                    "arguments_delta": delta,
                    "arguments": arguments,
                }
            )
        return out


def merge_text_tool_calls(message: dict[str, Any]) -> dict[str, Any]:
    if message.get("tool_calls"):
        return message
    visible, calls = extract_text_tool_calls(str(message.get("content") or ""))
    if not calls:
        return message
    message["content"] = visible
    message["tool_calls"] = calls
    return message
