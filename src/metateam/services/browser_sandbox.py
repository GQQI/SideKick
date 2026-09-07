"""CDP-backed browser sandbox (Playwright Chromium).

Host decision: cdp_playwright — see docs/browser-sandbox.md.

Playwright runs on a dedicated worker thread with its own asyncio event loop
and the Async API (one Playwright instance for the process). Callers stay sync
via `_WORKER.call`; never touch Page/Browser from FastAPI/agent threads.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlparse, urlunparse

from ..runtime.browser_protocol import (
    PROTOCOL_VERSION,
    STYLE_KEYS,
    DomComponentHint,
    DomElementPayload,
    DomRect,
)
from .tenant_context import get_user_id

HOST_KIND = "cdp_playwright"

# Extract clean http(s) URL; strip markdown/CJK glued by chat models.
_URL_EXTRACT_RE = re.compile(
    r"https?://[A-Za-z0-9][-A-Za-z0-9._~:/?#\[\]@!$&'()+,;=%]*",
    re.IGNORECASE,
)


def sanitize_browser_url(raw: str) -> str:
    """Return a navigable http(s) URL, or '' if none.

    ``http://localhost:5173**，已在/`` → ``http://localhost:5173/``
    """
    text = (raw or "").strip()
    if not text:
        return ""
    if text == "about:blank":
        return text
    m = _URL_EXTRACT_RE.search(text)
    candidate = m.group(0) if m else text
    star = candidate.find("*")
    if star >= 0:
        candidate = candidate[:star]
    for i, ch in enumerate(candidate):
        if ord(ch) > 127:
            candidate = candidate[:i]
            break
    candidate = candidate.rstrip("),.;:!?，。；！？*_~`")
    if not candidate:
        return ""
    try:
        parsed = urlparse(candidate)
        if parsed.scheme not in ("http", "https"):
            return ""
        if not parsed.netloc:
            return ""
        return urlunparse(parsed)
    except Exception:
        return ""


def resolve_browser_target(raw: str) -> str:
    """http(s) URL, or local workspace HTML served as http://127.0.0.1/..."""
    http = sanitize_browser_url(raw)
    if http:
        return http
    from .browser_preview import preview_http_url, resolve_local_html_file
    from .workspace_store import get_active_workspace

    ws = get_active_workspace()
    root_s = str(ws.get("path") or "").strip() if ws.get("configured") else ""
    root = Path(root_s) if root_s else None
    local = resolve_local_html_file(raw, workspace=root)
    if local is None or root is None:
        return ""
    return preview_http_url(local, root)


_IMAGE_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".ico",
    ".avif",
)
_BARE_HOST_RE = re.compile(
    r"^(?:www\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}"
    r"(?::\d{2,5})?(?:[/?#].*)?$"
)
_LOCALHOST_RE = re.compile(
    r"^(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:[/?#].*)?$",
    re.IGNORECASE,
)
def urls_match(left: str, right: str) -> bool:
    """True if two http(s) URLs point at the same document (ignore www / slash)."""

    def norm(raw: str) -> str:
        text = (raw or "").strip()
        if not text or text == "about:blank":
            return text
        try:
            parsed = urlparse(text)
        except Exception:
            return text.rstrip("/")
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        path = parsed.path or "/"
        if path != "/" and path.endswith("/"):
            path = path[:-1]
        scheme = (parsed.scheme or "https").lower()
        query = parsed.query
        return f"{scheme}://{host}{path}" + (f"?{query}" if query else "")

    a, b = norm(left), norm(right)
    return bool(a and b and a == b)


def _looks_like_asset_filename(text: str) -> bool:
    stem = (text or "").split("?")[0].split("#")[0].strip().replace("\\", "/")
    if not stem or "://" in stem:
        return False
    lower = stem.lower()
    return any(lower.endswith(ext) for ext in _IMAGE_SUFFIXES)


def lookup_screenshot_page_url(raw: str, workspace: Optional[Path] = None) -> str:
    """If ``raw`` is a saved screenshot, return the page URL it was taken from."""
    text = (raw or "").strip().replace("\\", "/")
    if not text:
        return ""
    last = ""
    try:
        last = str(SANDBOX.last_url() or "").strip()
    except Exception:
        last = ""
    candidates: list[Path] = []
    root: Optional[Path] = workspace
    if root is None:
        try:
            from .workspace_store import get_active_workspace

            ws = get_active_workspace()
            root_s = str(ws.get("path") or "").strip() if ws.get("configured") else ""
            root = Path(root_s) if root_s else None
        except Exception:
            root = None
    name = Path(text).name
    if root is not None:
        candidates.append(root / text)
        candidates.append(root / ".sidekick" / "browser" / name)
    candidates.append(Path(text))
    for cand in candidates:
        meta = Path(str(cand) + ".json")
        if not meta.is_file():
            meta = cand.with_suffix(cand.suffix + ".json") if cand.suffix else cand
        if not meta.is_file():
            continue
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        url = sanitize_browser_url(str((data or {}).get("url") or ""))
        if url:
            return url
    if root is not None:
        latest = root / ".sidekick" / "browser" / "latest.json"
        if latest.is_file():
            try:
                data = json.loads(latest.read_text(encoding="utf-8"))
                url = sanitize_browser_url(str((data or {}).get("url") or ""))
                if url:
                    return url
            except Exception:
                pass
    if last and last not in {"about:blank", "chrome://newtab/"}:
        return last
    return ""


def coerce_navigate_target(raw: str) -> str:
    """Turn a chat/tool argument into a navigable http(s) URL.

    Accepts full URLs, ``example.com``, ``localhost:5173``, or a workspace
    HTML file. Screenshot filenames like ``real_1_top.png`` recover the page
    they were taken from (sidecar / last session). If that fails they raise
    ValueError so the model can pass a real URL instead.
    """
    text = (raw or "").strip().strip("'\"")
    if not text:
        return ""
    if text == "about:blank":
        return text
    if _looks_like_asset_filename(text):
        recovered = lookup_screenshot_page_url(text)
        if recovered:
            return recovered
        raise ValueError(
            f"{text!r} is a screenshot path, not a web page. "
            "browser_navigate needs a full http(s) URL such as https://example.com "
            "(the page the shot was taken from). "
            "To inspect the image itself, call read_file on that path."
        )
    http = sanitize_browser_url(text)
    if http:
        return http
    if _LOCALHOST_RE.match(text):
        return sanitize_browser_url("http://" + text) or ("http://" + text)
    if _BARE_HOST_RE.match(text):
        host = text.split("/")[0].split("?")[0].split("#")[0]
        tld = host.rsplit(".", 1)[-1].lower()
        if tld not in {ext.lstrip(".") for ext in _IMAGE_SUFFIXES} | {
            "html",
            "htm",
            "js",
            "css",
            "json",
            "txt",
            "md",
        }:
            return sanitize_browser_url("https://" + text) or ("https://" + text)
    return resolve_browser_target(text)


_cdp_cached = ""


def discover_cdp_url() -> str:
    """Loopback CDP endpoint of the desktop BrowserView, if running."""
    global _cdp_cached
    if _cdp_cached:
        return _cdp_cached
    env = (os.getenv("SIDEKICK_CDP_URL") or "").strip()
    if env:
        _cdp_cached = env
        return env
    port = (os.getenv("SIDEKICK_CDP_PORT") or "8315").strip() or "8315"
    url = f"http://127.0.0.1:{port}"
    try:
        req = urllib.request.Request(f"{url}/json/version")
        with urllib.request.urlopen(req, timeout=0.35) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        browser = str(data.get("Browser") or "")
        if "Electron" in browser or "Chrome" in browser:
            _cdp_cached = url
            return url
    except Exception:
        pass
    return ""


def _is_workbench_url(url: str) -> bool:
    u = (url or "").lower()
    prefixes = []
    ui = (os.getenv("SIDEKICK_UI_URL") or "").strip().rstrip("/").lower()
    if ui:
        prefixes.append(ui)
    port = os.getenv("META_PORT", "8787")
    prefixes.extend(
        [
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
            "http://127.0.0.1:5177",
            "http://localhost:5177",
            "http://127.0.0.1:8787",
            "http://localhost:8787",
        ]
    )
    return any(u.startswith(p) for p in prefixes)


async def _find_guest_page(browser: Any) -> Any:
    """Locate the in-app BrowserView page; never the workbench renderer."""
    deadline = time.monotonic() + 8.0
    fallback = None
    while time.monotonic() < deadline:
        for ctx in list(getattr(browser, "contexts", None) or []):
            for page in list(getattr(ctx, "pages", None) or []):
                url = ""
                try:
                    url = page.url or ""
                except Exception:
                    continue
                if _is_workbench_url(url):
                    continue
                try:
                    if await page.evaluate("() => Boolean(window.__sidekickGuest)"):
                        return page
                except Exception:
                    pass
                # about:blank / empty guest view is fine; the workbench is not.
                if fallback is None:
                    fallback = page
        await asyncio.sleep(0.15)
    if fallback is not None:
        try:
            url = fallback.url or ""
        except Exception:
            url = ""
        if _is_workbench_url(url):
            return None
    return fallback


def loopback_url_candidates(url: str) -> list[str]:
    """Try IPv4 and IPv6 loopback — Vite on Windows often binds only one family."""
    text = (url or "").strip()
    if not text or text == "about:blank":
        return [text] if text else []
    try:
        parsed = urlparse(text)
    except Exception:
        return [text]
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
        return [text]
    port = parsed.port
    out: list[str] = []
    seen: set[str] = set()

    def add(hostname: str) -> None:
        hostpart = f"[{hostname}]" if ":" in hostname else hostname
        netloc = f"{hostpart}:{port}" if port else hostpart
        cand = urlunparse(parsed._replace(netloc=netloc))
        if cand not in seen:
            seen.add(cand)
            out.append(cand)

    add("127.0.0.1" if host == "0.0.0.0" else host)
    for h in ("127.0.0.1", "localhost", "::1"):
        add(h)
    return out or [text]


def _is_connection_refused(exc: BaseException) -> bool:
    s = str(exc).lower()
    return (
        "err_connection_refused" in s
        or "econnrefused" in s
        or "connection refused" in s
    )


_SELECT_BOOTSTRAP = r"""
(() => {
  if (window.__sidekickSelectBooted) return true;
  window.__sidekickSelectBooted = true;

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function xpathFor(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let i = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + "[" + i + "]");
      cur = cur.parentElement;
    }
    return "/html/body/" + parts.join("/");
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift("#" + cssEscape(cur.id));
        break;
      }
      if (cur.classList && cur.classList.length) {
        part += "." + Array.from(cur.classList).slice(0, 2).map(cssEscape).join(".");
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function reactHint(el) {
    const key = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!key) return null;
    let fiber = el[key];
    for (let i = 0; i < 12 && fiber; i++) {
      const t = fiber.type;
      if (typeof t === "function") {
        const name = t.displayName || t.name;
        if (name && !name.startsWith("_")) {
          return { name, framework: "react", file_hint: "" };
        }
      }
      if (typeof t === "object" && t && t.displayName) {
        return { name: String(t.displayName), framework: "react", file_hint: "" };
      }
      fiber = fiber.return;
    }
    return null;
  }

  function attrsOf(el) {
    const out = {};
    if (!el || !el.attributes) return out;
    for (const a of Array.from(el.attributes).slice(0, 24)) {
      if (a.name === "class" || a.name === "style") continue;
      let v = a.value || "";
      if (v.length > 120) v = v.slice(0, 120) + "…";
      out[a.name] = v;
    }
    return out;
  }

  function stylesOf(el) {
    const cs = window.getComputedStyle(el);
    const keys = __STYLE_KEYS__;
    const out = {};
    for (const k of keys) {
      try { out[k] = cs[k]; } catch (e) {}
    }
    return out;
  }

  function payloadFor(el) {
    const r = el.getBoundingClientRect();
    const classes = el.classList ? Array.from(el.classList).slice(0, 12) : [];
    let outer = "";
    try {
      outer = (el.outerHTML || "").slice(0, 4000);
    } catch (e) {}
    return {
      kind: "dom-element",
      protocol_version: __PROTOCOL_VERSION__,
      url: location.href,
      tag: (el.tagName || "").toLowerCase(),
      xpath: xpathFor(el),
      css_path: cssPath(el),
      id: el.id || "",
      classes,
      attributes: attrsOf(el),
      inner_text: (el.innerText || "").trim().slice(0, 800),
      role: el.getAttribute("role") || "",
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      computed_styles: stylesOf(el),
      component: reactHint(el),
      outer_html: outer,
      selected_at: Date.now() / 1000,
    };
  }

  let hl = null;
  let armed = false;
  let resolver = null;

  function ensureHl() {
    if (hl) return hl;
    hl = document.createElement("div");
    hl.setAttribute("data-sidekick-select-hl", "1");
    Object.assign(hl.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483646",
      border: "2px solid #2563eb",
      background: "rgba(37,99,235,0.12)",
      borderRadius: "2px",
      display: "none",
    });
    document.documentElement.appendChild(hl);
    return hl;
  }

  function onMove(ev) {
    if (!armed) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === hl) return;
    const r = el.getBoundingClientRect();
    const box = ensureHl();
    box.style.display = "block";
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = Math.max(0, r.width) + "px";
    box.style.height = Math.max(0, r.height) + "px";
  }

  function onClick(ev) {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === hl) return;
    armed = false;
    if (hl) hl.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    const payload = payloadFor(el);
    const r = resolver;
    resolver = null;
    if (r) r(payload);
  }

  window.__sidekickSelectArm = function (timeoutMs) {
    return new Promise((resolve) => {
      if (armed && resolver) {
        resolver(null);
      }
      armed = true;
      resolver = resolve;
      ensureHl();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      const ms = Math.max(1000, Number(timeoutMs) || 60000);
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        if (hl) hl.style.display = "none";
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        const r = resolver;
        resolver = null;
        if (r) r(null);
      }, ms);
    });
  };

  window.__sidekickSelectCancel = function () {
    armed = false;
    if (hl) hl.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    const r = resolver;
    resolver = null;
    if (r) r(null);
  };

  return true;
})()
""".replace("__STYLE_KEYS__", json.dumps(list(STYLE_KEYS))).replace(
    "__PROTOCOL_VERSION__", str(PROTOCOL_VERSION)
)


# Enumerate clickable/typeable elements so the agent can act without guessing
# selectors from raw HTML. Mirrors the cssPath() logic in _SELECT_BOOTSTRAP but
# is self-contained (evaluated standalone, not part of the Select Mode bundle).
_LIST_ELEMENTS_JS = r"""
(() => {
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift("#" + cssEscape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    return true;
  }
  function textOf(el) {
    const t = (
      el.innerText || el.value || el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") || el.getAttribute("title") || ""
    ).trim();
    return t.replace(/\s+/g, " ").slice(0, 120);
  }
  const SEL = 'a[href], button, [role="button"], [role="link"], [role="tab"], ' +
    '[role="menuitem"], [role="checkbox"], [role="switch"], input, select, ' +
    'textarea, summary, [onclick], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(SEL));
  const out = [];
  const seen = new Set();
  for (const el of nodes) {
    if (out.length >= __LIMIT__) break;
    if (!visible(el)) continue;
    const path = cssPath(el);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const tag = el.tagName.toLowerCase();
    const rec = {
      index: out.length,
      tag,
      type: el.getAttribute("type") || "",
      text: textOf(el),
      selector: path,
    };
    if (tag === "a") rec.href = el.getAttribute("href") || "";
    out.push(rec);
  }
  return out;
})()
"""


@dataclass
class _Job:
    factory: Callable[[], Awaitable[Any]]
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Optional[BaseException] = None


class _PlaywrightThread:
    """Dedicated thread: own asyncio loop + one async Playwright instance."""

    def __init__(self) -> None:
        self._q: queue.Queue[Optional[_Job]] = queue.Queue()
        self._thread = threading.Thread(
            target=self._loop, name="sidekick-playwright", daemon=True
        )
        self._started = False
        self._start_lock = threading.Lock()
        self._ready = threading.Event()
        self._pw: Any = None
        self._boot_error: Optional[BaseException] = None

    @property
    def playwright(self) -> Any:
        return self._pw

    def ensure_started(self) -> None:
        with self._start_lock:
            if self._started:
                return
            self._thread.start()
            self._started = True
        if not self._ready.wait(timeout=60.0):
            raise TimeoutError("browser sandbox worker failed to start")
        if self._boot_error is not None:
            raise RuntimeError(str(self._boot_error)) from self._boot_error

    def call(self, factory: Callable[[], Awaitable[Any]], *, timeout: float = 120.0) -> Any:
        self.ensure_started()
        job = _Job(factory=factory)
        self._q.put(job)
        if not job.done.wait(timeout=timeout):
            raise TimeoutError("browser sandbox worker timed out")
        if job.error is not None:
            raise RuntimeError(str(job.error)) from job.error
        return job.result

    def _loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        pw = None
        try:
            try:
                from playwright.async_api import async_playwright

                pw = loop.run_until_complete(async_playwright().start())
                self._pw = pw
            except BaseException as exc:  # noqa: BLE001
                self._boot_error = exc
                self._ready.set()
                return
            self._ready.set()
            while True:
                job = self._q.get()
                if job is None:
                    return
                try:
                    job.result = loop.run_until_complete(job.factory())
                except BaseException as exc:  # noqa: BLE001
                    job.error = exc
                finally:
                    job.done.set()
        finally:
            self._pw = None
            if pw is not None:
                try:
                    loop.run_until_complete(pw.stop())
                except Exception:
                    pass
            try:
                loop.close()
            except Exception:
                pass


_WORKER = _PlaywrightThread()


class BrowserSandbox:
    """Per-user Chromium session; all CDP ops marshalled onto `_WORKER`."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] = {}
        self._cdp_browser: Any = None
        self._last_url: dict[str, str] = {}

    def last_url(self, user_id: Optional[str] = None) -> str:
        uid = user_id or get_user_id()
        with self._lock:
            sess = self._sessions.get(uid)
            if sess and sess.get("url"):
                return str(sess.get("url") or "")
            return self._last_url.get(uid, "")

    def _remember_url(self, uid: str, url: str) -> None:
        text = (url or "").strip()
        if not text:
            return
        with self._lock:
            self._last_url[uid] = text
            sess = self._sessions.get(uid)
            if sess is not None:
                sess["url"] = text

    def host_kind(self) -> str:
        return HOST_KIND

    def playwright_available(self) -> tuple[bool, str]:
        try:
            import playwright  # noqa: F401
            from playwright.async_api import async_playwright  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            return False, (
                "Playwright not installed. Run: pip install playwright && playwright install chromium "
                f"({exc})"
            )
        return True, ""

    def status(self, user_id: Optional[str] = None) -> dict[str, Any]:
        uid = user_id or get_user_id()
        ok, err = self.playwright_available()
        with self._lock:
            sess = self._sessions.get(uid)
            info = None
            if sess and sess.get("page"):
                info = {
                    "url": sess.get("url") or "about:blank",
                    "started_at": sess.get("started_at"),
                    "ready": True,
                    "host": HOST_KIND,
                }
        return {
            "host": HOST_KIND,
            "available": ok,
            "message": err,
            "session": info,
        }

    def ensure_session(
        self,
        *,
        user_id: Optional[str] = None,
        url: str = "",
        headless: bool = False,
    ) -> dict[str, Any]:
        ok, err = self.playwright_available()
        if not ok:
            raise RuntimeError(err)
        uid = user_id or get_user_id()
        target = ""
        if (url or "").strip():
            try:
                target = coerce_navigate_target(url)
            except ValueError:
                target = resolve_browser_target(url)

        async def _op() -> dict[str, Any]:
            with self._lock:
                sess = self._sessions.get(uid)
            if self._session_alive(sess):
                if target:
                    try:
                        await self._navigate_unlocked(sess, target)
                    except Exception as exc:
                        if not self._is_target_closed(exc):
                            raise
                        await self._dispose_session(uid, sess)
                        return await self._ensure_on_worker(uid, target, headless=headless)
                with self._lock:
                    return self._public(sess)
            if sess:
                await self._dispose_session(uid, sess)
            return await self._ensure_on_worker(uid, target, headless=headless)

        return _WORKER.call(_op, timeout=90.0)

    def close(self, user_id: Optional[str] = None) -> None:
        uid = user_id or get_user_id()

        async def _op() -> None:
            with self._lock:
                sess = self._sessions.pop(uid, None)
            if not sess:
                return
            for key in ("context", "browser"):
                obj = sess.get(key)
                if obj is None:
                    continue
                try:
                    await obj.close()
                except Exception:
                    pass

        _WORKER.call(_op, timeout=30.0)

    def navigate(self, url: str, *, user_id: Optional[str] = None) -> dict[str, Any]:
        uid = user_id or get_user_id()
        try:
            target = coerce_navigate_target(url)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if not target:
            raise ValueError(
                f"invalid url: {url!r} — browser_navigate needs a full http(s) URL "
                "(e.g. https://example.com), localhost:port, or a workspace HTML file "
                "(e.g. report.html). Do not pass screenshot filenames."
            )

        async def _op() -> dict[str, Any]:
            with self._lock:
                sess = self._sessions.get(uid)
            if not self._session_alive(sess):
                if sess:
                    await self._dispose_session(uid, sess)
                return await self._ensure_on_worker(uid, target, headless=False)
            try:
                await self._navigate_unlocked(sess, target)
            except Exception as exc:
                if not self._is_target_closed(exc):
                    raise
                await self._dispose_session(uid, sess)
                return await self._ensure_on_worker(uid, target, headless=False)
            with self._lock:
                return self._public(sess)

        try:
            info = _WORKER.call(_op, timeout=90.0)
        except Exception as exc:
            # Desktop: let the UI/Electron loadURL the same target so the
            # in-app panel still opens even if Playwright CDP attach lags.
            self._remember_url(uid, target)
            return {
                "host": HOST_KIND,
                "url": target,
                "ready": False,
                "deferred": True,
                "note": str(exc),
            }
        self._remember_url(uid, str(info.get("url") or target))
        return info

    def screenshot_png(
        self,
        *,
        user_id: Optional[str] = None,
        full_page: bool = False,
    ) -> bytes:
        uid = user_id or get_user_id()

        async def _op() -> bytes:
            with self._lock:
                page = await self._alive_page(uid)
            return await page.screenshot(full_page=full_page, type="png")

        return _WORKER.call(_op, timeout=60.0)

    def page_content(
        self,
        *,
        user_id: Optional[str] = None,
        max_chars: int = 12000,
        include_html: bool = False,
    ) -> dict[str, Any]:
        """Return a compact, agent-friendly snapshot of the current page.

        This intentionally exposes rendered text by default.  Full markup is
        optional and bounded so a single browser inspection cannot consume an
        entire agent context window.
        """
        uid = user_id or get_user_id()
        limit = max(500, min(int(max_chars or 12000), 50000))

        async def _op() -> dict[str, Any]:
            with self._lock:
                page = await self._alive_page(uid)
            title = await page.title()
            text = await page.locator("body").inner_text(timeout=15000)
            payload: dict[str, Any] = {
                "url": page.url,
                "title": title,
                "text": (text or "").strip()[:limit],
                "truncated": len((text or "").strip()) > limit,
            }
            if include_html:
                html = await page.content()
                payload["html"] = html[:limit]
                payload["html_truncated"] = len(html) > limit
            return payload

        return _WORKER.call(_op, timeout=30.0)

    def console_logs(
        self,
        *,
        user_id: Optional[str] = None,
        limit: int = 80,
    ) -> list[dict[str, Any]]:
        uid = user_id or get_user_id()
        with self._lock:
            sess = self._sessions.get(uid)
            if not sess:
                return []
            logs = list(sess.get("console") or [])
            return logs[-max(1, min(limit, 200)) :]

    def pick_element(
        self,
        *,
        user_id: Optional[str] = None,
        timeout_ms: int = 60000,
        with_screenshot: bool = True,
    ) -> Optional[DomElementPayload]:
        uid = user_id or get_user_id()
        wait_s = max(5.0, (int(timeout_ms) / 1000.0) + 15.0)

        async def _op() -> Optional[DomElementPayload]:
            with self._lock:
                page = await self._alive_page(uid)
            await page.evaluate(_SELECT_BOOTSTRAP)
            raw = await page.evaluate(
                "(timeoutMs) => window.__sidekickSelectArm(timeoutMs)",
                int(timeout_ms),
            )
            if not raw or not isinstance(raw, dict):
                return None
            payload = DomElementPayload.model_validate(raw)
            if with_screenshot:
                try:
                    handle = None
                    if payload.xpath:
                        try:
                            handle = await page.query_selector(f"xpath={payload.xpath}")
                        except Exception:
                            handle = None
                    if handle is None and payload.css_path:
                        try:
                            handle = await page.query_selector(payload.css_path)
                        except Exception:
                            handle = None
                    if handle is not None:
                        png = await handle.screenshot(type="png")
                        payload.screenshot_base64 = base64.b64encode(png).decode("ascii")
                except Exception:
                    pass
            if payload.component is None:
                payload.component = DomComponentHint()
            if not isinstance(payload.rect, DomRect):
                payload.rect = DomRect.model_validate(payload.rect or {})
            return payload

        return _WORKER.call(_op, timeout=wait_s)

    def cancel_pick(self, *, user_id: Optional[str] = None) -> None:
        uid = user_id or get_user_id()

        async def _op() -> None:
            with self._lock:
                sess = self._sessions.get(uid)
                page = sess.get("page") if sess else None
            if not page:
                return
            try:
                await page.evaluate(
                    "() => { if (window.__sidekickSelectCancel) window.__sidekickSelectCancel(); }"
                )
            except Exception:
                pass

        try:
            _WORKER.call(_op, timeout=10.0)
        except Exception:
            pass

    def click_selector(self, selector: str, *, user_id: Optional[str] = None) -> str:
        uid = user_id or get_user_id()
        sel = (selector or "").strip()
        if not sel:
            return "ERROR: empty selector"

        async def _op() -> str:
            with self._lock:
                page = await self._alive_page(uid)
                sess = self._sessions[uid]
            await page.click(sel, timeout=15000)
            with self._lock:
                sess["url"] = page.url
            return f"clicked {sel} @ {page.url}"

        return _WORKER.call(_op, timeout=30.0)

    def type_text(
        self,
        selector: str,
        text: str,
        *,
        user_id: Optional[str] = None,
        clear: bool = True,
    ) -> str:
        uid = user_id or get_user_id()
        sel = (selector or "").strip()
        if not sel:
            return "ERROR: empty selector"

        async def _op() -> str:
            with self._lock:
                page = await self._alive_page(uid)
            if clear:
                await page.fill(sel, text or "", timeout=15000)
            else:
                await page.type(sel, text or "", timeout=15000)
            return f"typed into {sel}"

        return _WORKER.call(_op, timeout=30.0)

    def scroll(
        self,
        *,
        user_id: Optional[str] = None,
        direction: str = "down",
        amount: Optional[int] = None,
        selector: str = "",
    ) -> dict[str, Any]:
        uid = user_id or get_user_id()
        sel = (selector or "").strip()
        dirn = (direction or "down").strip().lower()

        async def _op() -> dict[str, Any]:
            with self._lock:
                page = await self._alive_page(uid)
            if sel:
                await page.locator(sel).scroll_into_view_if_needed(timeout=15000)
            elif dirn == "top":
                await page.evaluate("() => window.scrollTo(0, 0)")
            elif dirn == "bottom":
                await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
            else:
                delta = abs(int(amount)) if amount else 800
                if dirn == "up":
                    delta = -delta
                await page.mouse.wheel(0, delta)
            pos = await page.evaluate(
                "() => ({x: window.scrollX, y: window.scrollY, "
                "maxY: document.body.scrollHeight - window.innerHeight})"
            )
            return {"url": page.url, **(pos or {})}

        return _WORKER.call(_op, timeout=30.0)

    def hover_selector(self, selector: str, *, user_id: Optional[str] = None) -> str:
        uid = user_id or get_user_id()
        sel = (selector or "").strip()
        if not sel:
            return "ERROR: empty selector"

        async def _op() -> str:
            with self._lock:
                page = await self._alive_page(uid)
            await page.hover(sel, timeout=15000)
            return f"hovered {sel}"

        return _WORKER.call(_op, timeout=30.0)

    def press_key(
        self, key: str, *, user_id: Optional[str] = None, selector: str = ""
    ) -> str:
        uid = user_id or get_user_id()
        k = (key or "").strip()
        if not k:
            return "ERROR: empty key"
        sel = (selector or "").strip()

        async def _op() -> str:
            with self._lock:
                page = await self._alive_page(uid)
                sess = self._sessions[uid]
            if sel:
                await page.focus(sel, timeout=15000)
                await page.press(sel, k, timeout=15000)
            else:
                await page.keyboard.press(k)
            with self._lock:
                sess["url"] = page.url
            return f"pressed {k}" + (f" on {sel}" if sel else "")

        return _WORKER.call(_op, timeout=30.0)

    def wait_for(
        self,
        *,
        user_id: Optional[str] = None,
        selector: str = "",
        state: str = "visible",
        timeout_ms: int = 8000,
    ) -> str:
        uid = user_id or get_user_id()
        sel = (selector or "").strip()
        st = (state or "visible").strip().lower()
        if st not in ("visible", "hidden", "attached", "detached"):
            st = "visible"
        ms = max(200, min(int(timeout_ms or 8000), 30000))

        async def _op() -> str:
            with self._lock:
                page = await self._alive_page(uid)
            if sel:
                await page.locator(sel).wait_for(state=st, timeout=ms)
                return f"{sel} is now {st}"
            await asyncio.sleep(ms / 1000.0)
            return f"waited {ms}ms"

        return _WORKER.call(_op, timeout=(ms / 1000.0) + 15.0)

    def go_back(self, *, user_id: Optional[str] = None) -> dict[str, Any]:
        uid = user_id or get_user_id()

        async def _op() -> dict[str, Any]:
            with self._lock:
                page = await self._alive_page(uid)
                sess = self._sessions[uid]
            resp = await page.go_back(timeout=20000, wait_until="domcontentloaded")
            with self._lock:
                sess["url"] = page.url
            return {"url": page.url, "ok": resp is not None}

        return _WORKER.call(_op, timeout=30.0)

    def go_forward(self, *, user_id: Optional[str] = None) -> dict[str, Any]:
        uid = user_id or get_user_id()

        async def _op() -> dict[str, Any]:
            with self._lock:
                page = await self._alive_page(uid)
                sess = self._sessions[uid]
            resp = await page.go_forward(timeout=20000, wait_until="domcontentloaded")
            with self._lock:
                sess["url"] = page.url
            return {"url": page.url, "ok": resp is not None}

        return _WORKER.call(_op, timeout=30.0)

    def list_interactive_elements(
        self, *, user_id: Optional[str] = None, limit: int = 60
    ) -> list[dict[str, Any]]:
        uid = user_id or get_user_id()
        n = max(1, min(int(limit or 60), 150))

        async def _op() -> list[dict[str, Any]]:
            with self._lock:
                page = await self._alive_page(uid)
            js = _LIST_ELEMENTS_JS.replace("__LIMIT__", str(n))
            raw = await page.evaluate(js)
            return list(raw or [])

        return _WORKER.call(_op, timeout=30.0)

    def save_screenshot_to_workspace(
        self,
        workspace: Path,
        *,
        user_id: Optional[str] = None,
        name: str = "",
        full_page: bool = False,
    ) -> Path:
        png = self.screenshot_png(user_id=user_id, full_page=full_page)
        out_dir = Path(workspace) / ".sidekick" / "browser"
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = (name or f"shot_{int(time.time())}.png").replace("..", "")
        if not fname.endswith(".png"):
            fname += ".png"
        path = out_dir / fname
        path.write_bytes(png)
        page_url = self.last_url(user_id)
        meta = {
            "url": page_url,
            "path": fname,
            "saved_at": time.time(),
        }
        try:
            path.with_name(path.name + ".json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (out_dir / "latest.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        return path

    async def _ensure_on_worker(self, uid: str, url: str, *, headless: bool) -> dict[str, Any]:
        """Create session on the Playwright worker loop (shared async Playwright)."""
        with self._lock:
            existing = self._sessions.get(uid)
        if self._session_alive(existing):
            if url:
                try:
                    await self._navigate_unlocked(existing, url)
                except Exception as exc:
                    if not self._is_target_closed(exc):
                        raise
                    await self._dispose_session(uid, existing)
                    existing = None
                else:
                    return self._public(existing)
            else:
                return self._public(existing)
        elif existing:
            await self._dispose_session(uid, existing)

        pw = _WORKER.playwright
        if pw is None:
            raise RuntimeError("Playwright worker not ready")
        cdp = discover_cdp_url()
        if cdp:
            return await self._attach_desktop(uid, url)

        browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await context.new_page()
        page.on("console", lambda msg: self._on_console(uid, msg))
        go = url or "about:blank"
        if go != "about:blank":
            await self._goto_page(page, go)
        sess = {
            "user_id": uid,
            "browser": browser,
            "context": context,
            "page": page,
            "url": page.url,
            "started_at": time.time(),
            "console": [],
            "host": HOST_KIND,
        }

        def _gone(_=None) -> None:
            with self._lock:
                if self._sessions.get(uid) is sess:
                    self._sessions.pop(uid, None)

        try:
            page.on("close", _gone)
            browser.on("disconnected", _gone)
        except Exception:
            pass
        with self._lock:
            self._sessions[uid] = sess
            return self._public(sess)

    async def _attach_desktop(self, uid: str, url: str) -> dict[str, Any]:
        """Drive the Electron BrowserView over CDP — no extra Chromium window."""
        pw = _WORKER.playwright
        cdp = discover_cdp_url()
        if pw is None or not cdp:
            raise RuntimeError("desktop CDP endpoint is not available")
        browser = self._cdp_browser
        if browser is None:
            try:
                browser = await pw.chromium.connect_over_cdp(cdp)
            except Exception as exc:
                raise RuntimeError(
                    f"cannot attach to the in-app browser panel ({exc}). "
                    "Open the Browser sidebar and retry."
                ) from exc
            self._cdp_browser = browser
        page = await _find_guest_page(browser)
        if page is None:
            raise RuntimeError(
                "in-app browser panel not ready. Open the Browser sidebar once and retry."
            )
        try:
            page.on("console", lambda msg: self._on_console(uid, msg))
        except Exception:
            pass
        go = url or ""
        if go and go != "about:blank":
            await self._sync_desktop_url(page, go)
        sess = {
            "user_id": uid,
            "browser": browser,
            "context": page.context,
            "page": page,
            "cdp": True,
            "url": page.url,
            "started_at": time.time(),
            "console": [],
            "host": HOST_KIND,
        }

        def _gone(_=None) -> None:
            with self._lock:
                if self._sessions.get(uid) is sess:
                    self._sessions.pop(uid, None)

        try:
            page.on("close", _gone)
        except Exception:
            pass
        with self._lock:
            self._sessions[uid] = sess
            return self._public(sess)

    async def _alive_page(self, uid: str) -> Any:
        with self._lock:
            sess = self._sessions.get(uid)
            page = sess.get("page") if sess else None
        if self._page_alive(page):
            return page
        if discover_cdp_url():
            await self._attach_desktop(uid, self._last_url.get(uid, ""))
            with self._lock:
                page = (self._sessions.get(uid) or {}).get("page")
            if self._page_alive(page):
                return page
        raise RuntimeError(
            "browser session not started — open a URL in the Browser panel first "
            "(or Ctrl+click a link → Open in sandbox)"
        )

    def _page_unlocked(self, uid: str) -> Any:
        sess = self._sessions.get(uid)
        page = sess.get("page") if sess else None
        if self._page_alive(page):
            return page
        raise RuntimeError(
            "browser session not started — open a URL in the Browser panel first "
            "(or Ctrl+click a link → Open in sandbox)"
        )

    async def _sync_desktop_url(self, page: Any, url: str) -> None:
        """Wait for Electron's loadURL instead of racing it with Playwright goto."""
        if urls_match(getattr(page, "url", "") or "", url):
            return
        try:
            await page.wait_for_url(
                lambda u: urls_match(u, url),
                timeout=15000,
            )
        except Exception:
            # Panel may still be loading; do not page.goto — that aborts Electron.
            pass

    async def _goto_page(self, page: Any, url: str) -> None:
        last_exc: Optional[BaseException] = None
        if urls_match(getattr(page, "url", "") or "", url):
            return
        for cand in loopback_url_candidates(url):
            try:
                await page.goto(cand, wait_until="domcontentloaded", timeout=60000)
                return
            except Exception as exc:
                last_exc = exc
                if self._is_target_closed(exc):
                    raise
                if self._is_nav_aborted(exc) and urls_match(getattr(page, "url", "") or "", url):
                    return
                if _is_connection_refused(exc):
                    continue
                try:
                    await page.goto(cand, wait_until="commit", timeout=60000)
                    return
                except Exception as exc2:
                    last_exc = exc2
                    if self._is_target_closed(exc2) or not _is_connection_refused(exc2):
                        if self._is_nav_aborted(exc2) and urls_match(
                            getattr(page, "url", "") or "", url
                        ):
                            return
                        raise
        if last_exc:
            raise last_exc

    async def _navigate_unlocked(self, sess: dict[str, Any], url: str) -> None:
        page = sess["page"]
        if not self._page_alive(page):
            raise RuntimeError("Target page, context or browser has been closed")
        if sess.get("cdp"):
            await self._sync_desktop_url(page, url)
        else:
            await self._goto_page(page, url)
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
        sess["url"] = page.url or url

    @staticmethod
    def _is_nav_aborted(exc: BaseException) -> bool:
        msg = str(exc).lower()
        return "err_aborted" in msg or "(-3)" in msg or "net::err_aborted" in msg

    @staticmethod
    def _page_alive(page: Any) -> bool:
        if page is None:
            return False
        try:
            return not page.is_closed()
        except Exception:
            return False

    def _session_alive(self, sess: Optional[dict[str, Any]]) -> bool:
        if not sess:
            return False
        if not self._page_alive(sess.get("page")):
            return False
        browser = sess.get("browser")
        try:
            if browser is not None and hasattr(browser, "is_connected"):
                return bool(browser.is_connected())
        except Exception:
            return False
        return True

    @staticmethod
    def _is_target_closed(exc: BaseException) -> bool:
        msg = str(exc).lower()
        return "has been closed" in msg or "target closed" in msg or "browser has been closed" in msg

    async def _dispose_session(self, uid: str, sess: Optional[dict[str, Any]]) -> None:
        with self._lock:
            current = self._sessions.get(uid)
            if current is sess or (sess is None and current is not None):
                self._sessions.pop(uid, None)
        if not sess:
            return
        if sess.get("cdp"):
            return
        for key in ("context", "browser"):
            obj = sess.get(key)
            if obj is None:
                continue
            try:
                await obj.close()
            except Exception:
                pass

    def _public(self, sess: dict[str, Any]) -> dict[str, Any]:
        return {
            "host": HOST_KIND,
            "url": sess.get("url") or "about:blank",
            "started_at": sess.get("started_at"),
            "ready": True,
        }

    def _on_console(self, uid: str, msg: Any) -> None:
        try:
            entry = {
                "type": getattr(msg, "type", "") or "",
                "text": (getattr(msg, "text", "") or "")[:2000],
                "ts": time.time(),
            }
        except Exception:
            return
        with self._lock:
            sess = self._sessions.get(uid)
            if not sess:
                return
            logs = sess.setdefault("console", [])
            logs.append(entry)
            if len(logs) > 300:
                del logs[: len(logs) - 300]


SANDBOX = BrowserSandbox()
