"""MCP client — stdio + remote HTTP/SSE for Agent ToolRegistry."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Optional

from .mcp_config import McpServerConfig, McpSetup, load_mcp_config

_log = logging.getLogger("metateam.mcp")

_SAFE_NAME = re.compile(r"[^a-zA-Z0-9_]+")


def _run_coro(coro: Any, timeout: float = 120.0) -> Any:
    def _runner() -> Any:
        return asyncio.run(coro)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(_runner)
        return fut.result(timeout=timeout)


def mcp_tool_name(server_id: str, tool_name: str) -> str:
    sid = _SAFE_NAME.sub("_", server_id).strip("_") or "srv"
    tname = _SAFE_NAME.sub("_", tool_name).strip("_") or "tool"
    return f"mcp_{sid}_{tname}"[:64]


@dataclass
class McpToolInfo:
    server_id: str
    server_name: str
    name: str
    qualified: str
    description: str
    input_schema: dict[str, Any]


def _mcp_available() -> bool:
    try:
        import mcp  # noqa: F401

        return True
    except ImportError:
        return False


@asynccontextmanager
async def _open_session(server: McpServerConfig) -> AsyncIterator[Any]:
    from mcp import ClientSession

    transport = server.normalized_transport()
    if transport == "stdio":
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = {**os.environ, **(server.env or {})}
        params = StdioServerParameters(
            command=server.command,
            args=list(server.args or []),
            env=env,
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    if transport == "sse":
        from mcp.client.sse import sse_client

        async with sse_client(server.url, headers=dict(server.headers or {}) or None) as (
            read,
            write,
        ):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
        return

    # http / streamable-http
    from mcp.client.streamable_http import streamable_http_client
    from mcp.shared._httpx_utils import create_mcp_http_client

    headers = dict(server.headers or {})
    http_client = create_mcp_http_client(headers=headers or None)
    async with http_client:
        async with streamable_http_client(server.url, http_client=http_client) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session


async def _list_tools_async(server: McpServerConfig) -> list[McpToolInfo]:
    tools: list[McpToolInfo] = []
    async with _open_session(server) as session:
        result = await session.list_tools()
        for t in result.tools or []:
            schema = (
                t.inputSchema
                if isinstance(getattr(t, "inputSchema", None), dict)
                else {"type": "object", "properties": {}}
            )
            tools.append(
                McpToolInfo(
                    server_id=server.id,
                    server_name=server.name,
                    name=t.name,
                    qualified=mcp_tool_name(server.id, t.name),
                    description=(t.description or f"MCP:{server.name}/{t.name}")[:500],
                    input_schema=schema,
                )
            )
    return tools


async def _call_tool_async(
    server: McpServerConfig, tool_name: str, arguments: dict[str, Any]
) -> str:
    async with _open_session(server) as session:
        result = await session.call_tool(tool_name, arguments=arguments or {})
        parts: list[str] = []
        for block in result.content or []:
            text = getattr(block, "text", None)
            if text:
                parts.append(str(text))
            else:
                parts.append(str(block))
        out = "\n".join(parts).strip() or "(empty MCP result)"
        if getattr(result, "isError", False):
            return f"ERROR: MCP tool failed\n{out}"
        if len(out) > 14_000:
            out = out[:14_000] + "\n…[truncated]"
        return out


def list_enabled_tools(setup: Optional[McpSetup] = None) -> list[McpToolInfo]:
    if not _mcp_available():
        _log.warning("mcp package not installed — MCP tools disabled")
        return []
    cfg = setup or load_mcp_config()
    out: list[McpToolInfo] = []
    for server in cfg.servers:
        if not server.enabled:
            continue
        transport = server.normalized_transport()
        if transport == "stdio" and not (server.command or "").strip():
            continue
        if transport in ("http", "sse") and not (server.url or "").strip():
            continue
        try:
            out.extend(_run_coro(_list_tools_async(server), timeout=60.0))
        except Exception as exc:
            _log.warning("MCP list_tools failed for %s: %s", server.id, exc)
    return out


def call_tool(server: McpServerConfig, tool_name: str, arguments: dict[str, Any]) -> str:
    if not _mcp_available():
        return "ERROR: mcp package not installed (pip install mcp)"
    try:
        return _run_coro(_call_tool_async(server, tool_name, arguments), timeout=120.0)
    except Exception as exc:
        return f"ERROR: MCP call failed: {exc}"


def test_server(server: McpServerConfig) -> dict[str, Any]:
    if not _mcp_available():
        return {"ok": False, "error": "mcp package not installed"}
    try:
        tools = _run_coro(_list_tools_async(server), timeout=60.0)
        return {
            "ok": True,
            "tool_count": len(tools),
            "tools": [{"name": t.name, "qualified": t.qualified} for t in tools[:40]],
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def register_mcp_tools(
    registry: Any,
    *,
    Tool: Any,
    setup: Optional[McpSetup] = None,
) -> int:
    cfg = setup or load_mcp_config()
    by_id = {s.id: s for s in cfg.servers}
    tools = list_enabled_tools(cfg)
    count = 0
    for info in tools:
        server = by_id.get(info.server_id)
        if not server:
            continue

        def _make(srv: McpServerConfig, tname: str) -> Callable[..., str]:
            def _fn(**kwargs: Any) -> str:
                return call_tool(srv, tname, dict(kwargs))

            return _fn

        schema = info.input_schema if isinstance(info.input_schema, dict) else {
            "type": "object",
            "properties": {},
        }
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": {}, "description": info.description}

        registry.register(
            Tool(
                info.qualified,
                f"[MCP:{info.server_name}] {info.description}",
                schema,
                _make(server, info.name),
            )
        )
        count += 1
    return count
