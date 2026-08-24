# Browser sandbox — host decision & protocols

## Host decision (decide-host)

**Primary: Electron `BrowserView`** — live page painted over the Browser panel
host. Interact / Select Mode / HMR all hit the real document.
Launch with `start-desktop.bat`. See [desktop/README.md](../desktop/README.md).

**Fallback (plain web UI): CDP Playwright screenshots** — only when not running
inside the desktop shell. Not the recommended path for UI editing.

Playwright **Async API** runs on a dedicated worker thread with its own asyncio
loop (one Playwright instance for the process). Callers stay sync via a job
queue. Never call Page/Browser APIs from FastAPI or agent threads.

Sidekick is a loopback Web UI (FastAPI + Vite). Embedding a full BrowserView
inside a plain browser tab is unreliable for cross-origin select/computed styles.
The desktop shell uses a real Chromium view under the hood.

| Option | Fit for Sidekick | Verdict |
| --- | --- | --- |
| Desktop BrowserView (Electron) | Full Design Mode + DevTools panel | **Recommended** — `start-desktop.bat` |
| iframe-only preview | Same-origin only; weak select/CSS | Rejected as sole host |
| **CDP + Playwright Chromium** | Headed window for pick/verify; API drives session | Fallback when not in desktop |

Implications:

- Preview/select happen in a Sidekick-managed Chromium view (desktop) or CDP window (web).
- The Sidekick UI shows URL controls, live screenshot, Select Mode, and chat chips.
- Capability A (human select → chat) and Capability B (agent browser tools) share one session per user.

Install (once per machine):

```bash
pip install playwright
playwright install chromium
```

## Capability A — Select Mode chat attachment protocol

When the user arms Select Mode and clicks a node, the UI attaches a `dom-element` payload (not a raw F12 dump).

### Wire format (JSON object)

```json
{
  "kind": "dom-element",
  "protocol_version": 1,
  "url": "http://127.0.0.1:5173/",
  "tag": "button",
  "xpath": "/html/body/div[1]/button[2]",
  "css_path": "main .hero > button.cta",
  "id": "signup",
  "classes": ["cta", "primary"],
  "attributes": {"type": "button", "aria-label": "Sign up"},
  "inner_text": "Sign up",
  "role": "button",
  "rect": {"x": 120, "y": 40, "width": 128, "height": 40},
  "computed_styles": {
    "display": "inline-flex",
    "color": "rgb(255, 255, 255)",
    "backgroundColor": "rgb(37, 99, 235)",
    "fontSize": "14px",
    "fontWeight": "600",
    "padding": "8px 16px",
    "margin": "0px",
    "borderRadius": "8px"
  },
  "component": {"name": "PrimaryButton", "framework": "react", "file_hint": ""},
  "outer_html": "<button ...>...</button>",
  "screenshot_base64": optional PNG data URL or raw base64,
  "selected_at": 1710000000.0
}
```

### Agent prompt block

Serialized by `format_dom_element_for_agent` / `formatDomElementForAgent` as a fenced `dom-element` markdown section. Rules for the agent (injected with the block):

- Edit **source files**, not the live DOM.
- Prefer component / file hints when present; otherwise search by text, class, test id.
- Use screenshot + computed styles for visual intent.

### UI chip

Composer chip: `DOM · <tag>#id.classes` — full JSON lives in attachment `text` for the model; chip meta uses `kind: "dom-element"`.

## Capability B — Agent browser tools (same session)

Registered when the browser sandbox is available. Tools reuse the per-user CDP session:

| Tool | Purpose |
| --- | --- |
| `browser_navigate` | Open/reload a URL (localhost preferred) |
| `browser_screenshot` | Capture viewport PNG (saved under workspace `.sidekick/browser/`) |
| `browser_console` | Recent console messages |
| `browser_click` | Click by CSS selector or saved xpath |
| `browser_type` | Type into a focused/selector field |

Security defaults:

- Prefer `http://127.0.0.1` / `http://localhost` / `https://localhost`.
- Non-loopback navigations are allowed only after the same approval path as shell (tool not parallel-safe).
- No auto-run of arbitrary external sites without user-visible tool cards.

## Phased product surface

1. Browser side panel + CDP session + Select Mode → chat (Capability A) — implemented.
2. Agent tools on the same session (Capability B) — implemented as first cut.
3. Later: React Fiber source maps, draw-to-annotate, full DevTools pane, desktop BrowserView host.
