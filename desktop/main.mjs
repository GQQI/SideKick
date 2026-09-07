/**
 * Sidekick desktop — live embedded browser.
 *
 * Architecture:
 * - Main window hosts the React workbench
 * - A sibling BrowserView paints the live page over the Browser panel host
 * - Select Mode injects into that live webContents (not screenshots)
 */
import {
  app,
  BrowserWindow,
  BrowserView,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

const require = createRequire(import.meta.url);
const buildSelectBootstrap = require("./select-bootstrap.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const isDev = process.argv.includes("--dev");
const BACKEND_URL = process.env.SIDEKICK_BACKEND_URL || "http://127.0.0.1:8787";

/** Read-only app payload: repo root in dev, extraResources/sidekick when installed. */
function payloadRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sidekick");
  }
  return REPO_ROOT;
}

function dataDir() {
  return app.getPath("userData");
}

function logDir() {
  const dir = path.join(dataDir(), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

const STYLE_KEYS = [
  "display",
  "position",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "padding",
  "margin",
  "border",
  "borderRadius",
  "width",
  "height",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "opacity",
  "visibility",
  "overflow",
  "textAlign",
];

let mainWindow = null;
let browserView = null;
let backendProc = null;
let browserVisible = false;
let lastBounds = null;
const CDP_PORT = String(process.env.SIDEKICK_CDP_PORT || "8315");

function pythonCandidates() {
  const out = [];
  const push = (p) => {
    const s = String(p || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  // Portable order: explicit override → bundled runtime → tip file → project .venv → PATH
  push(process.env.SIDEKICK_PYTHON);
  if (app.isPackaged) {
    push(
      process.platform === "win32"
        ? path.join(payloadRoot(), "python", "python.exe")
        : path.join(payloadRoot(), "python", "bin", "python3"),
    );
    return out;
  }
  const tipFile = path.join(REPO_ROOT, ".sidekick-python");
  try {
    if (fs.existsSync(tipFile)) {
      push(fs.readFileSync(tipFile, "utf8").split(/\r?\n/)[0]);
    }
  } catch {
    /* ignore */
  }
  push(
    process.platform === "win32"
      ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(REPO_ROOT, ".venv", "bin", "python"),
  );
  push(process.platform === "win32" ? "python" : "python3");
  return out;
}

let lastPythonCheckError = "";
let backendStartupFatal = false;

const PYTHON_ENV_BLOCKLIST = new Set([
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONEXECUTABLE",
  "PYTHONUSERBASE",
  "PYTHONSAFEPATH",
  "PYTHONPLATLIBDIR",
  "VIRTUAL_ENV",
]);

/** Env for bundled Python: never inherit a host PYTHONHOME/PATH. */
function pythonChildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (PYTHON_ENV_BLOCKLIST.has(String(k).toUpperCase())) continue;
    env[k] = v;
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONNOUSERSITE = "1";
  return env;
}

function describePythonRuntime(py) {
  const dir = path.dirname(py);
  const lines = [`python: ${py}`, `exists: ${fs.existsSync(py)}`];
  try {
    const names = fs.readdirSync(dir);
    const zip = names.find((n) => /^python\d+\.zip$/i.test(n));
    const pth = names.find((n) => /^python\d+\._pth$/i.test(n));
    const encPy = path.join(dir, "Lib", "encodings", "__init__.py");
    const encPyc = path.join(dir, "Lib", "encodings", "__init__.pyc");
    lines.push(`dir: ${dir}`);
    lines.push(`stdlib zip: ${zip || "(missing)"}`);
    lines.push(`_pth: ${pth || "(missing)"}`);
    lines.push(
      `Lib/encodings: ${fs.existsSync(encPy) || fs.existsSync(encPyc) ? "yes" : "(missing)"}`,
    );
  } catch (e) {
    lines.push(`dir listing failed: ${e?.message || e}`);
  }
  return lines.join("\n");
}

function pythonHasFastapi(py) {
  try {
    const opts = {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
      windowsHide: true,
      env: pythonChildEnv(),
    };
    const dir = path.dirname(py);
    if (dir && dir !== "." && fs.existsSync(dir)) opts.cwd = dir;
    execFileSync(py, ["-c", "import encodings, fastapi, pydantic_core"], opts);
    return true;
  } catch (e) {
    lastPythonCheckError = String(e?.stderr || e?.message || e || "").trim();
    return false;
  }
}

/** Prefer env / tip file / project .venv that actually has Sidekick deps. */
function pythonBin() {
  for (const py of pythonCandidates()) {
    const isBare = py === "python" || py === "python3";
    if (!isBare && !fs.existsSync(py)) continue;
    if (pythonHasFastapi(py)) {
      console.log(`[backend] using python: ${py}`);
      return py;
    }
  }
  // A packaged build must never silently fall through to whatever "python"
  // happens to be on this machine's PATH — that produces a confusing crash
  // pointing at some unrelated system Python install instead of telling the
  // user the bundled runtime itself is broken.
  if (app.isPackaged) return null;
  const fallback = process.platform === "win32" ? "python" : "python3";
  console.error(
    `[backend] WARNING: no python with fastapi found; falling back to ${fallback}`,
  );
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchHealth(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json = null;
        }
        resolve({
          up: Boolean(res.statusCode && res.statusCode < 500),
          json,
        });
      });
    });
    req.on("error", () => resolve({ up: false, json: null }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ up: false, json: null });
    });
  });
}

function healthIsCurrent(json) {
  // auth_register is a capability flag: true only before first account exists.
  // After setup it is false — that is healthy, not a stale server.
  return Boolean(json && json.ok === true && typeof json.auth_register === "boolean");
}

function backendPort() {
  try {
    return Number(new URL(BACKEND_URL).port) || 8787;
  } catch {
    return 8787;
  }
}

function pidsListeningOn(port) {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const re = new RegExp(`[:\\[]${port}(?:]|\\s)`);
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line) || !re.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid > 0) pids.add(pid);
      }
    } else {
      try {
        const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
          encoding: "utf8",
        });
        for (const tok of out.split(/\s+/)) {
          const pid = Number(tok);
          if (pid > 0) pids.add(pid);
        }
      } catch {
        // 麒麟 / 精简 Linux 常无 lsof，退回 ss。
        try {
          const out = execFileSync("ss", ["-lptn", `sport = :${port}`], {
            encoding: "utf8",
          });
          for (const m of out.matchAll(/pid=(\d+)/g)) {
            const pid = Number(m[1]);
            if (pid > 0) pids.add(pid);
          }
        } catch {
          /* none listening */
        }
      }
    }
  } catch {
    /* none listening */
  }
  return [...pids];
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      /* already gone */
    }
  }
}

async function replaceStaleBackend() {
  const port = backendPort();
  const pids = pidsListeningOn(port);
  console.warn(
    `[backend] ${BACKEND_URL} is stale (missing auth_register); replacing pids ${pids.join(",") || "?"}`,
  );
  killPids(pids);
  const healthUrl = `${BACKEND_URL}/api/health`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const h = await fetchHealth(healthUrl, 800);
    if (!h.up) return;
    await sleep(200);
  }
}

function waitForHealth(url, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const h = await fetchHealth(url);
      if (h.up && healthIsCurrent(h.json)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Backend health timeout: ${url}`));
        return;
      }
      setTimeout(tick, 400);
    };
    void tick();
  });
}

function startBackend() {
  if (process.env.SIDEKICK_SKIP_BACKEND === "1") return null;
  const root = payloadRoot();
  const py = pythonBin();
  if (!py) {
    // app.isPackaged only (dev always returns a fallback string above).
    const bundled = path.join(
      payloadRoot(),
      "python",
      process.platform === "win32" ? "python.exe" : "bin/python3",
    );
    const detail =
      `${describePythonRuntime(bundled)}\n\n` +
      `failed to import FastAPI/Pydantic:\n${lastPythonCheckError || "(no error captured)"}\n\n` +
      "No module named 'encodings' means the bundled CPython stdlib was not " +
      "found (pythonXX.zip / pythonXX._pth / Lib\\encodings). Typical causes: " +
      "antivirus stripped files during install, or a host PYTHONHOME leaked " +
      "into the child process. Try:\n" +
      "  1. Uninstall, add an antivirus exclusion for the install folder, reinstall.\n" +
      "  2. Rebuild the installer with: scripts\\build-windows.ps1 -Force\n" +
      "  3. Or set SIDEKICK_PYTHON to a working python.exe with pip install -r requirements.txt.";
    console.error(`[backend] fatal: ${detail}`);
    backendStartupFatal = true;
    try {
      dialog.showErrorBox("Sidekick — 后端运行环境损坏 / Backend runtime broken", detail);
    } catch {
      /* headless / no display */
    }
    return null;
  }
  const env = pythonChildEnv();
  if (!env.PLAYWRIGHT_DOWNLOAD_HOST) {
    env.PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright";
  }
  if (!env.PIP_INDEX_URL) {
    env.PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple";
  }
  if (!env.PIP_TRUSTED_HOST) {
    env.PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn";
  }
  env.SIDEKICK_CDP_URL = env.SIDEKICK_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
  env.SIDEKICK_CDP_PORT = env.SIDEKICK_CDP_PORT || CDP_PORT;
  if (app.isPackaged) {
    env.SIDEKICK_REPO_ROOT = root;
    env.SIDEKICK_DATA_DIR = dataDir();
    const pwBrowsers = path.join(root, "ms-playwright");
    if (fs.existsSync(pwBrowsers)) {
      env.PLAYWRIGHT_BROWSERS_PATH = pwBrowsers;
    }
  }
  const child = spawn(py, [path.join(root, "main.py"), "serve"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logStream = null;
  try {
    logStream = fs.createWriteStream(path.join(logDir(), "backend.log"), {
      flags: "a",
    });
  } catch {
    /* ignore */
  }
  const pipe = (d, stream) => {
    stream.write(`[backend] ${d}`);
    try {
      logStream?.write(d);
    } catch {
      /* ignore */
    }
  };
  child.stdout?.on("data", (d) => pipe(d, process.stdout));
  child.stderr?.on("data", (d) => pipe(d, process.stderr));
  child.on("exit", (code, signal) => {
    console.error(`[backend] exited code=${code} signal=${signal || ""}`);
    try {
      logStream?.end();
    } catch {
      /* ignore */
    }
  });
  return child;
}

function emitNav(url) {
  mainWindow?.webContents.send("browser:navigated", url);
}

function ensureBrowserView() {
  if (browserView) return browserView;
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "guest-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:sidekick-guest",
      // Localhost Vite/Vue apps often need this for HMR websockets.
      webSecurity: true,
    },
  });
  try {
    browserView.setBackgroundColor("#111111");
  } catch {
    /* older electron */
  }
  try {
    browserView.webContents.setBackgroundThrottling(false);
  } catch {
    /* older electron */
  }
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    if (browserView && /^https?:\/\//i.test(url)) {
      void browserView.webContents.loadURL(url);
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  browserView.webContents.on("did-navigate", (_e, url) => emitNav(url));
  browserView.webContents.on("did-navigate-in-page", (_e, url) => emitNav(url));
  browserView.webContents.on("did-redirect-navigation", (_e, url) => emitNav(url));
  browserView.webContents.on(
    "did-fail-load",
    (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      mainWindow?.webContents.send("browser:load-fail", {
        code,
        description: desc,
        url,
      });
    },
  );
  // Start the guest renderer so Playwright CDP can see __sidekickGuest
  // even before the user types a URL.
  try {
    void browserView.webContents.loadURL("about:blank");
  } catch {
    /* ignore */
  }
  return browserView;
}

function setBrowserBounds(bounds) {
  if (!browserView || !mainWindow || !bounds) return;
  const b = {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(40, Math.round(Number(bounds.width) || 40)),
    height: Math.max(40, Math.round(Number(bounds.height) || 40)),
  };
  lastBounds = b;
  browserView.setBounds(b);
}

function attachBrowserView() {
  if (!mainWindow || !browserView) return;
  const views = typeof mainWindow.getBrowserViews === "function"
    ? mainWindow.getBrowserViews()
    : [];
  if (!views.includes(browserView)) {
    if (typeof mainWindow.addBrowserView === "function") {
      mainWindow.addBrowserView(browserView);
    } else {
      mainWindow.setBrowserView(browserView);
    }
  }
  // Keep the live view above the workbench chrome.
  if (typeof mainWindow.setTopBrowserView === "function") {
    try {
      mainWindow.setTopBrowserView(browserView);
    } catch {
      /* ignore */
    }
  }
}

function showBrowser(bounds) {
  ensureBrowserView();
  if (!mainWindow) return;
  attachBrowserView();
  browserVisible = true;
  if (bounds) setBrowserBounds(bounds);
  else if (lastBounds) setBrowserBounds(lastBounds);
  else mainWindow.webContents.send("browser:requestBounds");
}

function hideBrowser() {
  if (!mainWindow || !browserView) return;
  if (typeof mainWindow.removeBrowserView === "function") {
    try {
      mainWindow.removeBrowserView(browserView);
    } catch {
      mainWindow.setBrowserView(null);
    }
  } else {
    mainWindow.setBrowserView(null);
  }
  browserVisible = false;
}

function requestBoundsSoon() {
  if (!browserVisible) return;
  mainWindow?.webContents.send("browser:requestBounds");
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: "Sidekick",
    backgroundColor: "#ffffff",
    show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 8000);

  for (const ev of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    mainWindow.on(ev, () => requestBoundsSoon());
  }
  mainWindow.on("move", () => requestBoundsSoon());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const u = new URL(url);
      if (/\.(html?|pdf)$/i.test(u.pathname)) event.preventDefault();
    } catch {
      /* ignore */
    }
  });

  const uiUrl =
    process.env.SIDEKICK_UI_URL ||
    (isDev ? "http://127.0.0.1:5177" : `${BACKEND_URL}/`);

  try {
    await mainWindow.webContents.session.clearCache();
  } catch {
    /* ignore */
  }
  await mainWindow.loadURL(uiUrl);
  // Create the guest BrowserView up front so Playwright can attach over CDP
  // without launching a second Chromium window. Attach once so the renderer
  // process actually starts, then hide until the Browser sidebar is shown.
  ensureBrowserView();
  attachBrowserView();
  try {
    browserView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  } catch {
    /* ignore */
  }
  hideBrowser();
}

function normalizeNavUrl(raw) {
  let target = String(raw || "").trim();
  if (!target) return "";
  if (target === "about:blank") return target;

  // Local HTML: keep CJK in the path (do not strip non-ASCII like http chat junk).
  if (/^file:/i.test(target)) {
    try {
      return new URL(target).href;
    } catch {
      return target;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(target) && /\.html?([?#]|$)/i.test(target)) {
    try {
      return pathToFileURL(target.split(/[?#]/)[0]).href;
    } catch {
      return "";
    }
  }

  // Strip chat/markdown junk: http://localhost:5173**，已在/ → http://localhost:5173
  const m = target.match(
    /https?:\/\/[A-Za-z0-9][-A-Za-z0-9._~:/?#\[\]@!$&'()+,;=%]*/i,
  );
  if (m) target = m[0];
  const star = target.search(/\*/);
  if (star >= 0) target = target.slice(0, star);
  const nonAscii = target.search(/[^\x00-\x7F]/);
  if (nonAscii >= 0) target = target.slice(0, nonAscii);
  target = target.replace(/[*),.;:!?，。；！？*_~`]+$/g, "").trim();
  if (!target) return "";

  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return target;
    }
    return u.toString();
  } catch {
    return "";
  }
}

/** Vite/Node on Windows may listen on ::1 XOR 127.0.0.1 — try both families. */
function loopbackUrlCandidates(url) {
  const first = normalizeNavUrl(url);
  if (!first || first === "about:blank") return first ? [first] : [];
  let parsed;
  try {
    parsed = new URL(first);
  } catch {
    return [first];
  }
  if (parsed.protocol === "file:") return [first];
  const host = parsed.hostname;
  const loopback =
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "localhost" ||
    host === "::1";
  if (!loopback) return [first];
  const out = [];
  const seen = new Set();
  const pushHost = (hostname) => {
    const u = new URL(parsed);
    u.hostname = hostname;
    const s = u.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  pushHost(host === "0.0.0.0" ? "127.0.0.1" : host);
  pushHost("127.0.0.1");
  pushHost("localhost");
  pushHost("::1");
  return out;
}

function isConnectionRefused(err) {
  const code = String(err?.code || err?.errno || "");
  const msg = String(err?.message || err || "");
  return (
    code === "ERR_CONNECTION_REFUSED" ||
    msg.includes("ERR_CONNECTION_REFUSED") ||
    /econnrefused|connection refused/i.test(msg)
  );
}

function isAbortedNav(err) {
  const code = String(err?.code || err?.errno || err?.errorCode || "");
  const msg = String(err?.message || err || "");
  return (
    code === "ERR_ABORTED" ||
    code === "-3" ||
    msg.includes("ERR_ABORTED") ||
    /\(\s*-3\s*\)/.test(msg)
  );
}

function canonicalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text || text === "about:blank") return text;
  try {
    const u = new URL(text);
    let host = (u.hostname || "").toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let path = u.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

function urlsMatch(a, b) {
  const na = canonicalizeUrl(a);
  const nb = canonicalizeUrl(b);
  return Boolean(na && nb && na === nb);
}

function waitForGuestUrl(view, wants, timeoutMs) {
  const want = (wants || []).map(canonicalizeUrl).filter(Boolean);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let now = "";
      try {
        now = view.webContents.getURL();
      } catch {
        now = "";
      }
      if (want.some((w) => urlsMatch(now, w))) {
        cleanup();
        resolve(now);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        cleanup();
        resolve(now);
      }
    };
    const onNav = () => tick();
    const iv = setInterval(tick, 120);
    const to = setTimeout(tick, timeoutMs + 20);
    function cleanup() {
      clearInterval(iv);
      clearTimeout(to);
      try {
        view.webContents.removeListener("did-navigate", onNav);
        view.webContents.removeListener("did-finish-load", onNav);
        view.webContents.removeListener("did-stop-loading", onNav);
      } catch {
        /* ignore */
      }
    }
    try {
      view.webContents.on("did-navigate", onNav);
      view.webContents.on("did-finish-load", onNav);
      view.webContents.on("did-stop-loading", onNav);
    } catch {
      /* ignore */
    }
    tick();
  });
}

let navChain = Promise.resolve();

function friendlyNavError(err, url) {
  const msg = String(err?.message || err || "");
  if (isAbortedNav(err)) {
    return "";
  }
  if (isConnectionRefused(err)) {
    return (
      `无法连接 ${url}（连接被拒绝）。请先在对应项目里启动开发服务` +
      `（如 npm run dev）。本地预览请用终端里的地址；` +
      `开发服务器应绑定 127.0.0.1（Vite: server.host = "127.0.0.1"）。`
    );
  }
  return msg || "navigation failed";
}

function registerIpc() {
  ipcMain.handle("browser:show", (_e, bounds) => {
    showBrowser(bounds);
    return { ok: true, live: true };
  });
  ipcMain.handle("browser:hide", () => {
    hideBrowser();
    return { ok: true };
  });
  ipcMain.handle("browser:setBounds", (_e, bounds) => {
    if (browserVisible) setBrowserBounds(bounds);
    else lastBounds = bounds;
    return { ok: true };
  });
  ipcMain.handle("browser:navigate", async (_e, url) => {
    const candidates = loopbackUrlCandidates(url);
    if (!candidates.length) throw new Error("empty url");
    const run = async () => {
      const view = ensureBrowserView();
      showBrowser(lastBounds);
      let current = "";
      try {
        current = view.webContents.getURL();
      } catch {
        current = "";
      }
      if (candidates.some((c) => urlsMatch(current, c))) {
        emitNav(current);
        requestBoundsSoon();
        return { url: current, live: true };
      }
      let lastErr = null;
      for (const target of candidates) {
        try {
          await view.webContents.loadURL(target);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (isAbortedNav(err)) {
            const landed = await waitForGuestUrl(view, candidates, 8000);
            if (candidates.some((c) => urlsMatch(landed, c)) || (landed && landed !== "about:blank")) {
              lastErr = null;
              current = landed;
              break;
            }
            continue;
          }
          if (!isConnectionRefused(err)) {
            const nice = friendlyNavError(err, target);
            throw new Error(nice || String(err?.message || err));
          }
        }
      }
      if (lastErr) {
        const landed = await waitForGuestUrl(view, candidates, 2500);
        if (candidates.some((c) => urlsMatch(landed, c)) || (landed && landed !== "about:blank")) {
          current = landed;
        } else {
          const nice = friendlyNavError(lastErr, candidates[0]);
          throw new Error(nice || String(lastErr?.message || lastErr));
        }
      }
      current = current || view.webContents.getURL();
      emitNav(current);
      requestBoundsSoon();
      return { url: current, live: true };
    };
    const pending = navChain.then(run, run);
    navChain = pending.catch(() => {});
    return pending;
  });
  ipcMain.handle("browser:getUrl", () => {
    if (!browserView) return "about:blank";
    return browserView.webContents.getURL();
  });
  ipcMain.handle("browser:reload", async () => {
    if (!browserView) return { ok: false };
    browserView.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle("browser:goBack", async () => {
    if (!browserView?.webContents.navigationHistory?.canGoBack?.()) {
      if (browserView?.webContents.canGoBack?.()) browserView.webContents.goBack();
      return { ok: true };
    }
    if (browserView.webContents.navigationHistory.canGoBack()) {
      browserView.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });
  ipcMain.handle("browser:goForward", async () => {
    if (!browserView?.webContents.navigationHistory?.canGoForward?.()) {
      if (browserView?.webContents.canGoForward?.()) browserView.webContents.goForward();
      return { ok: true };
    }
    if (browserView.webContents.navigationHistory.canGoForward()) {
      browserView.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });
  ipcMain.handle("browser:selectCancel", async () => {
    if (!browserView) return { ok: true };
    try {
      await browserView.webContents.executeJavaScript(
        "window.__sidekickSelectCancel && window.__sidekickSelectCancel(); true",
        true,
      );
    } catch {
      /* ignore */
    }
    return { ok: true };
  });
  ipcMain.handle("browser:selectArm", async (_e, timeoutMs) => {
    if (!browserView) throw new Error("live browser not ready — open a URL first");
    showBrowser(lastBounds);
    const boot = buildSelectBootstrap(STYLE_KEYS, 1);
    await browserView.webContents.executeJavaScript(boot, true);
    const ms = Math.max(1000, Number(timeoutMs) || 60000);
    const raw = await browserView.webContents.executeJavaScript(
      `window.__sidekickSelectArm(${ms})`,
      true,
    );
    return raw || null;
  });
  ipcMain.handle("workspace:pickFolder", async (_e, optsIn) => {
    const opts = {
      title: String(optsIn?.title || "选择工作区文件夹"),
      properties: ["openDirectory", "createDirectory"],
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      const result = await dialog.showOpenDialog(mainWindow, opts);
      if (result.canceled || !result.filePaths?.[0]) {
        return { cancelled: true, path: null };
      }
      return { cancelled: false, path: result.filePaths[0] };
    }
    const result = await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths?.[0]) {
      return { cancelled: true, path: null };
    }
    return { cancelled: false, path: result.filePaths[0] };
  });
}

app.setAppUserModelId("com.sidekick.desktop");

// Windows Chromium often fails GPUCache move with Access Denied (0x5),
// especially when productName/userData is non-ASCII (Sidekick) or another
// Electron still holds the folder. Must run before app.ready.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  if (app.isPackaged) {
    try {
      app.setPath("userData", path.join(app.getPath("appData"), "Sidekick"));
    } catch {
      /* keep default */
    }
  }
}

// Must be before app.ready. Playwright connects here and drives the in-app
// BrowserView instead of spawning a popup Chromium.
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (gotTheLock) app.whenReady().then(async () => {
  registerIpc();

  const healthUrl = `${BACKEND_URL}/api/health`;
  const existing = await fetchHealth(healthUrl);
  if (existing.up && healthIsCurrent(existing.json)) {
    console.log(`[backend] reusing existing server at ${BACKEND_URL}`);
  } else {
    if (existing.up) {
      await replaceStaleBackend();
    }
    backendProc = startBackend();
    if (backendStartupFatal) {
      app.quit();
      return;
    }
    try {
      await waitForHealth(healthUrl);
    } catch (e) {
      const late = await fetchHealth(healthUrl);
      if (late.up) {
        console.warn(`[backend] health wait timed out but server is up; opening anyway`);
      } else {
        console.error(e);
        const logPath = path.join(logDir(), "backend.log");
        dialog.showErrorBox(
          "Sidekick",
          `后端未能启动。\n\n${e?.message || e}\n\n日志：${logPath}\n\n` +
            (app.isPackaged
              ? "请重新安装，或检查 8787 端口是否被占用。"
              : "请先运行 start-desktop.bat 安装 Python 依赖。"),
        );
      }
    }
  }

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  hideBrowser();
  // Only kill backend we started ourselves.
  if (backendProc && !backendProc.killed) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(backendProc.pid), "/T", "/F"]);
      } else {
        backendProc.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
});
