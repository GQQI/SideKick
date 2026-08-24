/**
 * Sidekick desktop — Cursor-style live embedded browser.
 *
 * Architecture (aligned with Cursor Agents Window browser):
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
import { fileURLToPath } from "node:url";
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

function pythonHasFastapi(py) {
  try {
    execFileSync(py, ["-c", "import fastapi"], {
      stdio: "ignore",
      timeout: 20000,
      windowsHide: true,
    });
    return true;
  } catch {
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
  const fallback =
    process.env.SIDEKICK_PYTHON || (process.platform === "win32" ? "python" : "python3");
  console.error(
    `[backend] WARNING: no python with fastapi found; falling back to ${fallback}`,
  );
  return fallback;
}

function healthOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForHealth(url, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await healthOk(url)) {
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
  if (!pythonHasFastapi(py)) {
    const hint = app.isPackaged
      ? "Bundled Python is missing FastAPI. Reinstall Sidekick, or set SIDEKICK_PYTHON."
      : "[backend] fastapi missing. Run start-desktop.bat once (creates .venv + installs deps), or:\n" +
        "  .\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt\n" +
        "Or set SIDEKICK_PYTHON / write its path to .sidekick-python";
    console.error(hint);
  }
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
  };
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Localhost Vite/Vue apps often need this for HMR websockets.
      webSecurity: true,
    },
  });
  try {
    browserView.setBackgroundColor("#111111");
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
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  for (const ev of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    mainWindow.on(ev, () => requestBoundsSoon());
  }
  mainWindow.on("move", () => requestBoundsSoon());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
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
}

function normalizeNavUrl(raw) {
  let target = String(raw || "").trim();
  if (!target) return "";
  if (target === "about:blank") return target;

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
    // Vite/Node on Windows often listens on ::1 only; 127.0.0.1 then refuses.
    if (u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0") {
      u.hostname = "localhost";
    }
    return u.toString();
  } catch {
    return "";
  }
}

function friendlyNavError(err, url) {
  const code = err?.code || err?.errno || "";
  const msg = String(err?.message || err || "");
  if (code === "ERR_CONNECTION_REFUSED" || msg.includes("ERR_CONNECTION_REFUSED")) {
    return (
      `无法连接 ${url}（连接被拒绝）。请先在对应项目里启动开发服务` +
      `（如 npm run dev），并用终端里显示的地址打开；Windows 上优先用 localhost 而不是 127.0.0.1。`
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
    const target = normalizeNavUrl(url);
    if (!target) throw new Error("empty url");
    const view = ensureBrowserView();
    showBrowser(lastBounds);
    try {
      await view.webContents.loadURL(target);
    } catch (err) {
      // Retry once: explicit 127.0.0.1 → localhost (IPv6-only listeners)
      const alt = String(url || "").includes("127.0.0.1")
        ? String(url).replace("127.0.0.1", "localhost")
        : "";
      if (alt && alt !== target) {
        try {
          await view.webContents.loadURL(alt);
        } catch (err2) {
          throw new Error(friendlyNavError(err2, alt));
        }
      } else {
        throw new Error(friendlyNavError(err, target));
      }
    }
    const current = view.webContents.getURL();
    emitNav(current);
    requestBoundsSoon();
    return { url: current, live: true };
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
}

app.setAppUserModelId("com.sidekick.desktop");

// Windows Chromium often fails GPUCache move with Access Denied (0x5)
// when another Electron holds the folder. Must run before app.ready.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}

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

  const alreadyUp = await healthOk(`${BACKEND_URL}/api/health`);
  if (!alreadyUp) {
    backendProc = startBackend();
    try {
      await waitForHealth(`${BACKEND_URL}/api/health`);
    } catch (e) {
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
  } else {
    console.log(`[backend] reusing existing server at ${BACKEND_URL}`);
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
