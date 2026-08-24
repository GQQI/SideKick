# Sidekick

[中文](README.md) · English

**Sidekick** is an open-source **local multi-agent AI workspace** you run on your own machine.
Open a folder, chat in the browser, and let a main agent plus sub-agents search and edit files — with human approval, Skills you can drop in, and Memory that sticks.

Built to be **forked**: clear Python + Vite layers, add a Skill or tool without fighting a black box.
Built to be **cheap to run**: context compression, on-demand Skills, and separate main / sub / compress models so the same work burns far fewer tokens.

**Windows · macOS · Linux** · default **http://127.0.0.1:8787**

---

## Screenshots

![Workbench](docs/screenshots/workbench.jpg)

![Dark mode](docs/screenshots/dark-mode.jpg)

---

## Why Sidekick

**Fork-friendly**  
`src/` core runtime + `ui/` control interface (OpenClaw-style layout). API, agent runtime, tools, Skills, and Memory are separate layers — ship a private fork by dropping Skills or registering tools.

**Token-efficient**  
Compress when the context fills (capped rounds). Skills are callable tools, not giant prompts pasted every turn. Point heavy work at a strong model and delegation / compression at cheaper ones.

**Workspace-native**  
Content search, streaming chat, and a detail panel in one UI. Mutating actions (write, delete, shell, memory) ask for approval first.

**Yours**  
Runs locally. Bring your own API key. History, Memory, and workspace stay on disk you control.

---

## Capabilities

| | |
|---|---|
| **Chat + tools** | SSE streaming, attachments, stop cleanly, edit & resend (optionally restore files to that step) |
| **Files** | Create / rename / delete (confirm) / drag-move; search by name **and** content with line jump |
| **Browser sandbox** | Desktop: live Electron BrowserView; Web: Playwright screenshots; Select Mode → chat; agent `browser_*` tools |
| **Memory** | Append, remove, or rewrite `MEMORY.md` (approval required) |
| **Skills** | Drop packs under `src/skills/`, invoke with `/skill <name>` |
| **Models** | Separate main, sub-agent, and compress models |
| **UI** | Chinese / English · light / dark · paginated history |

### Slash commands

`/help` · `/new` · `/clear` · `/skills` · `/skill <name>` · `/memory` · `/history` · `/browser` · `/stop`

Browser sandbox needs Playwright Chromium once:

```bash
pip install playwright
playwright install chromium
```

See [docs/browser-sandbox.md](docs/browser-sandbox.md).

---

## Quick start

**Requirements:** Python 3.10+ · Node.js 18+ (UI only)

### Windows PowerShell

```powershell
cd path\to\Sidekick
python -m pip install -r requirements.txt
python main.py
```

Or double-click **`start.bat`** (no `PYTHONPATH` needed).

### macOS / Linux

```bash
cd /path/to/Sidekick
python3 -m pip install -r requirements.txt
python3 main.py
```

Open **http://127.0.0.1:8787** → pick a workspace folder → Settings → Model → API key

### Desktop app (live embedded browser)

Double-click **`start-desktop.bat`** to create a project-local **`.venv`** (via `uv` / `py` / `python`), install Python deps and Playwright Chromium if needed, install desktop/UI npm packages, build the UI, and launch Electron with a **live BrowserView** preview (not screenshots). No machine-specific conda paths — clone and re-run on a new machine.

```powershell
.\start-desktop.bat
```

Optional override: `SIDEKICK_PYTHON` or `.sidekick-python`. Prefer `http://localhost:PORT` for local Vite apps on Windows.

See [desktop/README.md](desktop/README.md) · [docs/browser-sandbox.md](docs/browser-sandbox.md).

### Windows offline installer (.exe)

Build once on an **online Windows PC**, then copy the Setup exe to machines that have no internet and no Python/Node:

```powershell
.\scripts\build-windows.bat
```

Output: `desktop/dist/Sidekick-Setup-<version>-win-x64.exe` (plus a portable zip).

Install needs no network. Chat still needs a model API (cloud, or LAN/local Ollama). Data lives in `%APPDATA%\Sidekick\`.

See [packaging/windows/README.md](packaging/windows/README.md).

> Never commit real keys, `.env`, sessions, or `model.json` (see `.gitignore`).

### Local security (defaults)

- Binds `127.0.0.1` only; non-loopback bind requires `META_ALLOW_REMOTE=1` (unsafe).
- API requires a local token (`X-Sidekick-Token`, stored in `src/data/.local_token`); the UI fetches it via `/api/bootstrap`.
- API keys in `model.json` are encrypted at rest (`src/data/.secret_key`).
- Shell tools are on by default (`META_ALLOW_SHELL=1`) and still go through the agent approval gate; set `0` to disable entirely.
- **Approval boundary:** ApprovalGate covers agent tool calls; UI file writes rely on the local token plus in-app confirm dialogs.

### UI (optional)

```powershell
cd ui
npm i
npm run dev          # HMR
# npm run build      # then backend can serve the static build
```

---

## Architecture

```mermaid
flowchart TB
  subgraph Client["Browser"]
    UI["Workbench"]
    SSE["Event stream"]
  end
  subgraph Server["python main.py"]
    API["REST"]
    Agent["Agent · tools · approval · compress"]
    Child["Sub-agents"]
  end
  subgraph Disk["Local disk"]
    WS["Workspace"]
    Skills["src/skills/"]
    Memory["src/memory/"]
    Model["Model config"]
  end
  UI --> API
  UI --> SSE
  API --> Agent
  Agent --> Child
  Agent --> WS
  Agent --> Skills
  Agent --> Memory
  Agent --> Model
```

```
Sidekick/
├── src/metateam/     # core: API, agents, tools
├── src/skills/       # drop-in Skills
├── src/memory/       # MEMORY.md
├── src/data/         # model.json.example (no secrets)
├── src/sessions/     # sessions (local, not committed)
├── src/workspace/    # default workspace placeholder
├── ui/               # Vite control UI
├── desktop/          # Electron shell (live embedded browser)
├── packaging/windows/# offline installer notes (build artifacts not committed)
├── scripts/          # Python bootstrap, Windows packager
├── docs/
├── main.py
├── start.bat
├── start-desktop.bat # one-click deps + desktop
├── requirements.txt
├── README.md
└── README.en.md
```
