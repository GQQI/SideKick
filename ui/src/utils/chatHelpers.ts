/** Pure helpers extracted from App to keep the shell leaner. */

import { fileRawUrl, withAuthToken, type FilePayload, type SessionDetailMessage } from "../api";
import type { ChatMsg, DetailView, MsgAttachment, ToolCard } from "../types/chat";
import { formatToolSummary } from "./toolSummary";

export type GreetingKey =
  | "greetingLateNight"
  | "greetingMorning"
  | "greetingNoon"
  | "greetingAfternoon"
  | "greetingEvening";

/** Local browser time (not UTC / server). */
export function greetingKey(now = new Date()): GreetingKey {
  const h = now.getHours();
  if (h < 5) return "greetingLateNight";
  if (h < 11) return "greetingMorning";
  if (h < 14) return "greetingNoon";
  if (h < 18) return "greetingAfternoon";
  return "greetingEvening";
}

export function isSkillInjectMessage(content: string) {
  const text = (content || "").trim();
  return (
    text.includes("【Skill 已注入】") ||
    text.includes("----- SKILL START -----") ||
    text.startsWith("请立即调用函数工具")
  );
}

/** Hide Sidekick-internal user turns from the chat UI / history titles. */
export function isHiddenUserContent(content: string): boolean {
  const c = (content || "").trim();
  if (!c) return true;
  if (c.startsWith("[CONTEXT COMPACTION]")) return true;
  if (/^\[Plan step\s/i.test(c)) return true;
  if (c.startsWith("[sidekick:")) return true;
  if (c.startsWith("Iteration budget exhausted")) return true;
  return false;
}

export function buildSuggestions(
  t: (key: import("../i18n").MsgKey, ...args: string[]) => string,
) {
  return [
    { label: t("suggestSkills"), text: "/skills" },
    { label: t("suggestMemory"), text: "/memory" },
    { label: t("suggestListDir"), text: t("suggestListDirText") },
    { label: t("suggestWrite"), text: t("suggestWriteText") },
  ];
}

export function formatTime(ts: number, locale: "zh" | "en" = "zh") {
  if (!ts) return "";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatArgs(args: unknown) {
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args);
  }
}

/** Best-effort parse of streaming write_file / tool JSON arguments. */
export function softParseToolArgs(raw: string): Record<string, unknown> {
  const text = raw || "";
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* partial */
  }
  const out: Record<string, unknown> = { _partial: true };
  const pathMatch = text.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (pathMatch) {
    try {
      out.path = JSON.parse(`"${pathMatch[1]}"`);
    } catch {
      out.path = pathMatch[1];
    }
  }
  const contentKey = text.search(/"content"\s*:\s*"/);
  if (contentKey >= 0) {
    const after = text.slice(contentKey);
    const m = after.match(/"content"\s*:\s*"/);
    if (m && m.index != null) {
      let i = m.index + m[0].length;
      let content = "";
      while (i < after.length) {
        const ch = after[i];
        if (ch === "\\" && i + 1 < after.length) {
          const n = after[i + 1];
          const map: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            '"': '"',
            "\\": "\\",
          };
          content += map[n] ?? n;
          i += 2;
          continue;
        }
        if (ch === '"') break;
        content += ch;
        i += 1;
      }
      out.content = content;
    }
  }
  if (Object.keys(out).length === 1 && out._partial) {
    out._raw = text;
  }
  return out;
}

export function writeFilePreview(args: unknown): { path: string; content: string } | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const path = typeof obj.path === "string" ? obj.path : "";
  const content = typeof obj.content === "string" ? obj.content : "";
  if (!path && !content) return null;
  return { path, content };
}

export function formatBytes(n?: number) {
  if (n == null || Number.isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeFileKind(kind?: string): string {
  if (!kind) return "text";
  if (kind === "office") return "document";
  if (kind === "binary") return "unsupported";
  return kind;
}

export function fileToDetail(
  file: FilePayload,
  opts?: { highlightQuery?: string; focusLine?: number },
): Exclude<DetailView, null> {
  const kind = normalizeFileKind(file.kind);
  return {
    type: "file",
    path: file.path,
    content: file.content || "",
    dirty: false,
    kind,
    mime: file.mime,
    size: file.size,
    preview: file.preview || "",
    editable: Boolean(file.editable ?? kind === "text"),
    message: file.message || (kind === "unsupported" ? "暂不支持预览此文件" : ""),
    // Prefer path-based URL so the current local token is always attached
    rawUrl: withAuthToken(file.raw_url) || fileRawUrl(file.path),
    highlightQuery: opts?.highlightQuery,
    focusLine: opts?.focusLine,
    forceEdit: false,
  };
}

export function langFromPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".sh")) return "bash";
  return "";
}

let _seq = 0;
export const uid = () => `m_${++_seq}_${Date.now()}`;

const ATTACH_MARKER = "用户上传了以下附件，请根据附件内容进行分析与回答：";

export function parseUserAttachments(content: string): {
  text: string;
  attachments: MsgAttachment[];
} {
  const raw = content || "";
  const idx = raw.indexOf(ATTACH_MARKER);
  const attachPart = idx >= 0 ? raw.slice(idx) : raw;
  const text = idx >= 0 ? raw.slice(0, idx).trim() : raw;
  const attachments: MsgAttachment[] = [];
  const re = /### 附件：([^\n]+)\n路径：`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attachPart)) !== null) {
    attachments.push({ name: m[1].trim(), path: m[2].trim() });
  }
  if (idx < 0 && attachments.length === 0) {
    return { text: raw, attachments: [] };
  }
  return { text, attachments };
}

/** Map persisted session messages → UI chat bubbles (hides internal turns). */
/** Soften skill tool-call prompts when restoring history without display text. */
export function normalizeRestoredUserContent(content: string): string {
  const text = (content || "").trim();
  if (!text.startsWith("请立即调用函数工具")) return text;
  const tool = text.match(/`(skill_[A-Za-z0-9_]+)`/)?.[1];
  const taskMatch = text.match(/task 参数为：(.+?)(?:。|$)/);
  const task = (taskMatch?.[1] || "").trim();
  if (task && !task.includes("可省略 task")) {
    const name = (tool || "skill").replace(/^skill_/, "").replace(/_/g, "-");
    return `/skill ${name} ${task}`;
  }
  if (tool) {
    return `/skill ${tool.replace(/^skill_/, "").replace(/_/g, "-")}`;
  }
  return text;
}

export function mapSessionMessages(messages: SessionDetailMessage[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      if (isHiddenUserContent(m.content || "")) continue;
      const parsed = parseUserAttachments(
        normalizeRestoredUserContent(m.content || ""),
      );
      out.push({
        id: uid(),
        role: "user",
        content: parsed.text,
        attachments: parsed.attachments.length ? parsed.attachments : undefined,
      });
      continue;
    }
    if (m.role === "assistant") {
      const content = (m.content || "").trim();
      if (!content && !m.reasoning) continue;
      out.push({
        id: uid(),
        role: "assistant",
        content,
        reasoning: m.reasoning || undefined,
      });
      continue;
    }
    if (m.role === "tool") {
      const name = m.name || "tool";
      const callId = m.call_id || uid();
      const statusRaw = (m.status || "done").toLowerCase();
      const status: ToolCard["status"] =
        statusRaw === "error"
          ? "error"
          : statusRaw === "pending"
            ? "pending"
            : statusRaw === "running" || statusRaw === "streaming"
              ? "done"
              : "done";
      const tool: ToolCard = {
        id: uid(),
        callId,
        name,
        args: m.args ?? {},
        result: m.result || "",
        status,
        summary: formatToolSummary(name, m.args ?? {}),
      };
      out.push({
        id: tool.id,
        role: "tool",
        content: "",
        tool,
      });
    }
  }
  return out;
}
