import type { ModelSetup } from "../types/modelSetup";
import { normalizeModelSetup } from "../types/modelSetup";

export type Health = {
  ok: boolean;
  demo: boolean;
  model: string;
  subagent_model?: string;
  base_url?: string;
  provider?: string;
  main_provider_id?: string;
  subagent_provider_id?: string;
  workspace: string;
  workspace_configured?: boolean;
  thinking_enabled?: boolean;
  reasoning_effort?: string;
  context_limit?: number;
  compress_trigger_ratio?: number;
};

export type SkillItem = {
  name: string;
  tool: string;
  description: string;
  path: string;
  mode: string;
};

/** @deprecated use ModelSetup */
export type ModelConfig = ModelSetup;

export type WorkspaceItem = {
  id: string;
  name: string;
  path: string;
  is_default?: boolean;
};

export type RuntimeEvent = {
  type: string;
  data: Record<string, unknown>;
  ts?: number;
  agent_id?: string;
  parent_id?: string;
};

const BASE = "";
const TOKEN_KEY = "sidekick_local_token";
let _token: string | null =
  typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
let _bootstrapPromise: Promise<string | null> | null = null;

export type AuthStatus = {
  needs_setup: boolean;
  multi_user: boolean;
  user_count: number;
  auth_required?: boolean;
  authenticated?: boolean;
  user?: { id: string; username: string; email?: string } | null;
  token?: string | null;
  token_header?: string;
};

export function getStoredToken(): string | null {
  return _token;
}

export function setApiToken(token: string | null) {
  _token = token;
  if (typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const headers = new Headers();
  if (_token) headers.set("X-Sidekick-Token", _token);
  const r = await fetch(`${BASE}/api/auth/status`, { headers });
  if (!r.ok) throw new Error(`/api/auth/status failed: ${r.status}`);
  return r.json() as Promise<AuthStatus>;
}

export async function authSetup(payload: {
  username: string;
  email: string;
  password: string;
}) {
  const r = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let detail = `setup failed: ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const body = (await r.json()) as {
    token?: string;
    user?: { id: string; username: string; email?: string };
  };
  if (body.token) setApiToken(body.token);
  return body;
}

export async function authLogin(payload: { email: string; password: string }) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let detail = `login failed: ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const body = (await r.json()) as {
    token?: string;
    user?: { id: string; username: string; email?: string };
  };
  if (body.token) setApiToken(body.token);
  return body;
}

export async function authLogout() {
  try {
    const headers = new Headers();
    if (_token) headers.set("X-Sidekick-Token", _token);
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers });
  } catch {
    /* ignore */
  }
  setApiToken(null);
}

export async function ensureApiToken(): Promise<string | null> {
  if (_token) return _token;
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    try {
      const r = await fetch(`${BASE}/api/bootstrap`);
      if (!r.ok) return null;
      const body = (await r.json()) as AuthStatus;
      if (body.auth_required) {
        // Multi-user: must login — do not invent a token
        return null;
      }
      if (body.token) {
        setApiToken(body.token);
        return body.token;
      }
    } catch {
      /* ignore */
    }
    return null;
  })();
  try {
    return await _bootstrapPromise;
  } finally {
    _bootstrapPromise = null;
  }
}

async function authHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra || {});
  const token = await ensureApiToken();
  if (token) headers.set("X-Sidekick-Token", token);
  return headers;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders(init?.headers);
  const r = await fetch(`${BASE}${url}`, { ...init, headers });
  if (!r.ok) {
    let detail = `${url} failed: ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

/** Public health check (no token required). */
export const fetchHealth = async () => {
  const r = await fetch(`${BASE}/api/health`);
  if (!r.ok) throw new Error(`/api/health failed: ${r.status}`);
  return r.json() as Promise<Health>;
};

export const createSession = () =>
  json<{ id: string; demo: boolean }>("/api/sessions", { method: "POST" });

export type SessionItem = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: number;
  user_turns?: number;
  demo?: boolean;
  source?: string;
};

export type SessionsPage = {
  items: SessionItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type SessionDetailMessage = {
  role: string;
  content?: string;
  reasoning?: string;
  name?: string;
  call_id?: string;
  args?: unknown;
  result?: string;
  status?: string;
};

export type SessionDetail = {
  id: string;
  title: string;
  messages: SessionDetailMessage[];
  tokens: number;
  limit?: number;
  demo: boolean;
  busy?: boolean;
  pending_approvals?: Array<{
    id: string;
    tool: string;
    args?: unknown;
    summary?: string;
  }>;
  pending_asks?: Array<{
    id: string;
    question: string;
    options?: Array<{ key: string; label: string }>;
    allow_custom?: boolean;
    custom_label?: string;
  }>;
  pending_plans?: Array<{
    id: string;
    summary?: string;
    tasks?: Array<{ id?: string; title: string; detail?: string; status?: string }>;
  }>;
};

export const HISTORY_PAGE_SIZE = 20;

export const fetchSessions = (page = 1, pageSize = HISTORY_PAGE_SIZE) =>
  json<SessionsPage>(
    `/api/sessions?page=${encodeURIComponent(String(page))}&page_size=${encodeURIComponent(String(pageSize))}`,
  );
export const fetchSession = (id: string) => json<SessionDetail>(`/api/sessions/${id}`);
export const stopSession = (id: string) =>
  json<{ status: string }>(`/api/sessions/${id}/stop`, { method: "POST" });
export const truncateSession = (
  id: string,
  keepUserTurns: number,
  opts?: { restoreFiles?: boolean },
) =>
  json<{
    status: string;
    session_id: string;
    keep_user_turns: number;
    messages: number;
    restore_files?: boolean;
    file_undo?: { undone_count?: number; partial?: boolean; errors?: string[] };
  }>(`/api/sessions/${id}/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keep_user_turns: keepUserTurns,
      restore_files: Boolean(opts?.restoreFiles),
    }),
  });

export const fetchSkills = () => json<SkillItem[]>("/api/skills");
export const fetchSkill = (name: string) =>
  json<{
    name: string;
    tool: string;
    description: string;
    path: string;
    body: string;
    mode?: string;
  }>(`/api/skills/${encodeURIComponent(name)}`);
export const fetchMemory = async () =>
  (await json<{ content: string }>("/api/memory")).content || "";
export const saveMemory = (content: string) =>
  json("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
export type MemoryItem = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  enabled: boolean;
  updated_at?: number;
};
export type MemoryCategory = {
  id: string;
  name: string;
  memories: MemoryItem[];
};
export type MemoryLibrary = {
  version: number;
  categories: MemoryCategory[];
};

export const fetchMemoryLibrary = () => json<MemoryLibrary>("/api/memory/library");
export const saveMemoryLibrary = (library: MemoryLibrary) =>
  json<{ status: string; library: MemoryLibrary }>("/api/memory/library", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(library),
  });
export const fetchModel = async () =>
  normalizeModelSetup(await json<unknown>("/api/model"));

export const saveModel = async (patch: Partial<ModelSetup>) => {
  const res = await json<{ status: string; config: unknown; note: string }>(
    "/api/model",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  return { ...res, config: normalizeModelSetup(res.config) };
};

export const selectModel = async (
  role: "main" | "subagent" | "compress",
  providerId: string,
  model: string,
) => {
  const res = await json<{ status: string; config: unknown; note: string }>(
    "/api/model/select",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, provider_id: providerId, model }),
    },
  );
  return { ...res, config: normalizeModelSetup(res.config) };
};

export const fetchWorkspaces = () =>
  json<{
    configured: boolean;
    items: WorkspaceItem[];
    active: { path: string; name: string; configured?: boolean } | null;
  }>("/api/workspaces");
export const createWorkspace = (path: string) =>
  json<{
    status: string;
    configured: boolean;
    active: { path: string; name: string };
    items: WorkspaceItem[];
  }>("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
export const setWorkspace = (path: string, create = false) =>
  json<{
    status: string;
    configured: boolean;
    active: { path: string; name: string };
    items: WorkspaceItem[];
  }>("/api/workspaces/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, create }),
  });

export const browseWorkspace = () =>
  json<{ cancelled: boolean; path: string | null }>("/api/workspaces/browse", {
    method: "POST",
  });

export const deleteSession = (id: string) =>
  json<{ status: string }>(`/api/sessions/${id}`, { method: "DELETE" });

export const saveSession = (id: string) =>
  json<{ status: string; path?: string }>(`/api/sessions/${id}/save`, {
    method: "POST",
  });

export type FsEntry = {
  name: string;
  path: string;
  /** Absolute path on the host machine (when provided by the API). */
  abs_path?: string;
  type: "file" | "dir";
  size?: number | null;
  kind?: string;
};

export type FsList = {
  path: string;
  name: string;
  type: string;
  entries: FsEntry[];
};

export type FileKind =
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "unsupported";

export type FilePayload = {
  path: string;
  name?: string;
  kind: FileKind | string;
  mime?: string;
  size: number;
  content?: string;
  preview?: string;
  truncated?: boolean;
  editable?: boolean;
  supported?: boolean;
  message?: string;
  raw_url?: string;
};

export const listFiles = (path = ".") =>
  json<FsList>(`/api/files?path=${encodeURIComponent(path)}`);
export type SearchHit = {
  path: string;
  name: string;
  kind: "file" | "dir" | string;
  match: "name" | "content" | string;
  line: number;
  snippet: string;
  /** All matching line numbers (content hits). */
  lines?: number[];
  /** Total matching lines found (may equal lines.length when capped). */
  matchCount?: number;
  /** Per-line snippets for expanded view. */
  snippets?: { line: number; text: string }[];
};
export const searchFiles = (q: string, path = ".") =>
  json<{ query: string; hits: SearchHit[] }>(
    `/api/files/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(path)}`,
  );

export type BrowserStatus = {
  host: string;
  available: boolean;
  message: string;
  session: { url: string; started_at: number; ready: boolean; host: string } | null;
};

export const browserStatus = () => json<BrowserStatus>("/api/browser/status");
export const browserStart = (url = "", headless = false) =>
  json<{ host: string; url: string; started_at: number; ready: boolean }>(
    "/api/browser/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, headless }),
    },
  );
export const browserClose = () =>
  json<{ status: string }>("/api/browser/session", { method: "DELETE" });
export const browserNavigate = (url: string) =>
  json<{ host: string; url: string; started_at: number; ready: boolean }>(
    "/api/browser/navigate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
export const browserSelect = (timeout_ms = 60000, with_screenshot = true) =>
  json<{ ok: boolean; element: Record<string, unknown> | null; message?: string }>(
    "/api/browser/select",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout_ms, with_screenshot }),
    },
  );
export const browserSelectCancel = () =>
  json<{ status: string }>("/api/browser/select/cancel", { method: "POST" });
export const browserScreenshotUrl = (bust = Date.now()) => {
  const q = new URLSearchParams({ t: String(bust) });
  if (_token) q.set("token", _token);
  return `/api/browser/screenshot?${q.toString()}`;
};

/** Fetch screenshot as a blob URL (revoker must call URL.revokeObjectURL). */
export async function browserFetchScreenshot(fullPage = false): Promise<string> {
  const headers = await authHeaders();
  const q = fullPage ? "?full_page=true" : "";
  const r = await fetch(`${BASE}/api/browser/screenshot${q}`, { headers });
  if (!r.ok) {
    let detail = `screenshot failed: ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      try {
        detail = (await r.text()) || detail;
      } catch {
        /* ignore */
      }
    }
    throw new Error(detail);
  }
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}
export const uploadFile = async (file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  const headers = await authHeaders();
  const r = await fetch(`${BASE}/api/files/upload`, { method: "POST", body: fd, headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `upload failed: ${r.status}`);
  }
  return r.json() as Promise<FilePayload & { uploaded?: boolean }>;
};
export const readFileContent = (path: string) =>
  json<FilePayload>(`/api/files/content?path=${encodeURIComponent(path)}`);
export const getApiToken = () => _token;

/** Attach local token to /api/... URLs used by <img>/<iframe>/window.open (no custom headers). */
export function withAuthToken(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("/api/")) return url;
  const token = _token;
  if (!token) return url;
  try {
    const u = new URL(url, "http://local.invalid");
    if (!u.searchParams.has("token")) u.searchParams.set("token", token);
    return `${u.pathname}${u.search}`;
  } catch {
    return url.includes("?") ? `${url}&token=${encodeURIComponent(token)}` : `${url}?token=${encodeURIComponent(token)}`;
  }
}

export const fileRawUrl = (path: string) => {
  const q = new URLSearchParams({ path });
  if (_token) q.set("token", _token);
  return `/api/files/raw?${q.toString()}`;
};
export const writeFileContent = (path: string, content: string) =>
  json<{ path: string; size: number }>("/api/files/content", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
export const createFsEntry = (path: string, kind: "file" | "dir" = "file") =>
  json<{ path: string; type: string }>("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, kind }),
  });
export const deleteFsEntry = (path: string, recursive = false) =>
  json<{ path: string; type: string; deleted: boolean }>(
    `/api/files?path=${encodeURIComponent(path)}&recursive=${recursive ? "true" : "false"}`,
    { method: "DELETE" },
  );
export const renameFsEntry = (path: string, newName: string) =>
  json<{ path: string; from: string; name: string; type: string }>("/api/files/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, new_name: newName }),
  });
export const moveFsEntry = (path: string, destDir: string) =>
  json<{ path: string; from: string; to_dir: string; type: string }>("/api/files/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, dest_dir: destDir }),
  });

export const revealFsEntry = (path: string) =>
  json<{ status: string; path: string; abs_path: string; type: string }>(
    "/api/files/reveal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );

export const decideApproval = (
  sessionId: string,
  approvalId: string,
  approved: boolean,
  remember = false,
  patchArgs?: Record<string, unknown>,
) =>
  json<{ status: string; approval_id: string; approved: boolean; remember?: boolean }>(
    `/api/sessions/${sessionId}/approvals/${approvalId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved,
        remember,
        ...(patchArgs ? { patch_args: patchArgs } : {}),
      }),
    },
  );

export const answerAsk = (
  sessionId: string,
  askId: string,
  choice: string,
  text = "",
  optionLabel = "",
) =>
  json<{ status: string; ask_id: string; choice: string }>(
    `/api/sessions/${sessionId}/asks/${askId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choice,
        text,
        option_label: optionLabel,
      }),
    },
  );

export const confirmPlan = (
  sessionId: string,
  planId: string,
  body: {
    approved: boolean;
    summary?: string;
    tasks?: Array<{ id?: string; title: string; detail?: string; status?: string }>;
  },
) =>
  json<{ status: string; plan_id: string; approved: boolean }>(
    `/api/sessions/${sessionId}/plans/${planId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export type ChatHandlers = {
  onEvent: (ev: RuntimeEvent) => void;
  onFinal: (text: string, meta: Record<string, unknown>) => void;
  onError: (msg: string) => void;
  onAbort?: () => void;
};

function parseSseBlock(block: string): RuntimeEvent | null {
  // Normalize CRLF so event:/data: parsing is reliable on Windows servers
  const lines = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comments / keep-alives
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Support both full envelope {type,data} and bare payloads
    if (typeof parsed.type === "string") {
      return parsed as unknown as RuntimeEvent;
    }
    return {
      type: eventName || "message",
      data: parsed as Record<string, unknown>,
    };
  } catch {
    return {
      type: eventName || "message",
      data: { text: raw, message: raw },
    };
  }
}

export async function streamChat(
  message: string,
  sessionId: string | null,
  handlers: ChatHandlers,
  signal?: AbortSignal,
  mode: "plan" | "agent" = "agent",
  display?: string,
): Promise<string | null> {
  let r: Response;
  try {
    const headers = await authHeaders({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    const body: Record<string, unknown> = {
      message,
      session_id: sessionId,
      mode,
    };
    if (display && display !== message) body.display = display;
    r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      handlers.onAbort?.();
      return sessionId;
    }
    throw e;
  }
  if (!r.ok || !r.body) {
    handlers.onError(`chat failed: ${r.status}`);
    return sessionId;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sid = sessionId;
  let sawFinal = false;
  let aborted = false;

  const handle = (ev: RuntimeEvent) => {
    const type = ev.type || "message";
    if (type === "session") {
      sid = String(ev.data?.session_id || sid);
      handlers.onEvent({ ...ev, type });
      return;
    }
    if (type === "final") {
      sawFinal = true;
      handlers.onFinal(String(ev.data?.text ?? ""), ev.data || {});
      sid = String(ev.data?.session_id || sid);
      return;
    }
    if (type === "error") {
      handlers.onError(String(ev.data?.message || "error"));
      return;
    }
    handlers.onEvent({ ...ev, type });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines; servers often use CRLF (\r\n\r\n)
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";
      for (const block of parts) {
        const ev = parseSseBlock(block);
        if (ev) handle(ev);
      }
    }
    if (buf.trim()) {
      const ev = parseSseBlock(buf);
      if (ev) handle(ev);
    }
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      aborted = true;
      handlers.onAbort?.();
    } else {
      throw e;
    }
  }
  if (!sawFinal && !aborted) {
    handlers.onFinal("", { session_id: sid, partial: true });
  }
  return sid;
}

export async function attachSessionEvents(
  sessionId: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const headers = await authHeaders({ Accept: "text/event-stream" });
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "GET",
      headers,
      signal,
    });
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      handlers.onAbort?.();
      return;
    }
    throw e;
  }
  if (!r.ok || !r.body) {
    handlers.onError(`attach failed: ${r.status}`);
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawFinal = false;
  let aborted = false;
  const handle = (ev: RuntimeEvent) => {
    const type = ev.type || "message";
    if (type === "final") {
      sawFinal = true;
      handlers.onFinal(String(ev.data?.text ?? ""), ev.data || {});
      return;
    }
    if (type === "error") {
      handlers.onError(String(ev.data?.message || "error"));
      return;
    }
    handlers.onEvent({ ...ev, type });
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";
      for (const block of parts) {
        const ev = parseSseBlock(block);
        if (ev) handle(ev);
      }
    }
    if (buf.trim()) {
      const ev = parseSseBlock(buf);
      if (ev) handle(ev);
    }
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) {
      aborted = true;
      handlers.onAbort?.();
    } else {
      throw e;
    }
  }
  if (!sawFinal && !aborted) {
    handlers.onFinal("", { session_id: sessionId, partial: true });
  }
}

export type GitFileEntry = {
  path: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  kind?: string;
  added?: number;
  deleted?: number;
};

export type GitBranch = {
  name: string;
  current?: boolean;
  remote?: boolean;
};

export type GitSnapshot = {
  is_repo: boolean;
  branch?: string;
  files?: GitFileEntry[];
  status?: string;
  error?: string;
  message?: string;
  branches?: GitBranch[];
  ahead?: number;
  behind?: number;
  upstream?: string;
  remote?: string;
  remote_url?: string;
  totals?: { files: number; added: number; deleted: number };
};

export const fetchGit = () => json<GitSnapshot>("/api/git");
export const fetchGitReview = (sessionId?: string | null) =>
  json<GitSnapshot>(
    sessionId
      ? `/api/git/review?session_id=${encodeURIComponent(sessionId)}`
      : "/api/git/review",
  );
export type GitFileDiff = {
  path: string;
  old: string;
  new: string;
  kind: string;
  is_new?: boolean;
  is_deleted?: boolean;
  binary?: boolean;
};
export const fetchGitFileDiff = (path: string, sessionId?: string | null) => {
  const q = new URLSearchParams({ path });
  if (sessionId) q.set("session_id", sessionId);
  return json<GitFileDiff>(`/api/git/file-diff?${q.toString()}`);
};
export const gitStage = (paths: string[]) =>
  json<GitSnapshot>("/api/git/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
export const gitUnstage = (paths: string[]) =>
  json<GitSnapshot>("/api/git/unstage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
export const gitCommit = (message: string) =>
  json<GitSnapshot>("/api/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
export const gitFetch = () =>
  json<GitSnapshot>("/api/git/fetch", { method: "POST" });
export const gitPull = () =>
  json<GitSnapshot>("/api/git/pull", { method: "POST" });
export const gitPush = () =>
  json<GitSnapshot>("/api/git/push", { method: "POST" });
export const gitCheckout = (branch: string, create = false) =>
  json<GitSnapshot>("/api/git/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, create }),
  });
export const gitSetRemote = (url: string, name = "origin") =>
  json<GitSnapshot>("/api/git/remote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name }),
  });

export type UndoItem = {
  id: string;
  label?: string;
  op?: string;
  ts?: number;
  session_id?: string;
  user_turn?: number;
  user_text?: string;
  files?: string[];
};

export const fetchUndo = () => json<{ count: number; items: UndoItem[] }>("/api/files/undo");
export const postUndo = (id?: string) =>
  json<{ status: string; undone_count?: number; remaining?: number; errors?: string[] }>(
    "/api/files/undo",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id } : {}),
    },
  );

export type McpServer = {
  id: string;
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_keys?: string[];
  url?: string;
  headers?: Record<string, string>;
  header_keys?: string[];
  enabled: boolean;
};

export type McpSetup = {
  version: number;
  servers: McpServer[];
};

export const fetchMcp = () => json<McpSetup>("/api/mcp");

export const saveMcp = (setup: McpSetup) =>
  json<McpSetup & { status?: string }>("/api/mcp", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setup),
  });

export const testMcpServer = (server: McpServer) =>
  json<{ ok: boolean; error?: string; tool_count?: number; tools?: unknown[] }>(
    "/api/mcp/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server),
    },
  );
