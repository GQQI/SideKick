"""Public-web search (models often call web_search; this runtime did not have it)."""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from html import unescape

from ..tool_registry import Tool, ToolRegistry


_HREF = re.compile(
    r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
    re.I | re.S,
)
_TAG = re.compile(r"<[^>]+>")


def _plain(html: str) -> str:
    return unescape(_TAG.sub("", html or "")).strip()


def web_search(query: str = "", max_results: int = 5) -> str:
    from ...core.hostinfo import network_available

    q = (query or "").strip()
    if not q:
        return "ERROR: empty query"
    if not network_available():
        return (
            "ERROR: this host is offline (no public internet). "
            "Do not retry web_search or browser_navigate. "
            "Use search_text / read_file / list_dir on the local workspace."
        )
    n = max(1, min(int(max_results or 5), 8))
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": q})
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; Sidekick/1.0)"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=18) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        return (
            f"ERROR: web_search failed ({exc}). "
            "If the host is offline, stop — do not switch to browser_navigate. "
            f"Otherwise you may retry later or open: {url}"
        )
    hits: list[dict[str, str]] = []
    for href, title_html in _HREF.finditer(raw):
        title = _plain(title_html)
        link = unescape(href)
        if not title or not link:
            continue
        hits.append({"title": title, "url": link})
        if len(hits) >= n:
            break
    if not hits:
        return json.dumps(
            {"query": q, "results": [], "hint": f"No parseable results. Try browser_navigate: {url}"},
            ensure_ascii=False,
        )
    return json.dumps({"query": q, "results": hits}, ensure_ascii=False)


def register_web_tools(reg: ToolRegistry) -> None:
    reg.register(
        Tool(
            "web_search",
            "Search the public internet when the host is ONLINE. "
            "If Host environment says OFFLINE, do not call this. "
            "Not search_text (that greps the workspace). "
            "Aliases some models invent: search, search_web, google_search.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {"type": "integer", "default": 5},
                },
                "required": ["query"],
            },
            web_search,
            parallel_safe=True,
        )
    )
