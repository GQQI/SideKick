/** Shared chat / tool UI types for the main app. */

export type ToolCard = {
  id: string;
  callId: string;
  name: string;
  args: unknown;
  argsRaw?: string;
  result?: string;
  status: "streaming" | "running" | "done" | "error" | "pending";
  summary?: string;
};

export type ApprovalPrompt = {
  approvalId: string;
  callId: string;
  name: string;
  args: unknown;
  summary: string;
};

export type AskOption = { key: string; label: string };

export type AskPrompt = {
  askId: string;
  callId: string;
  sessionId: string;
  question: string;
  options: AskOption[];
  allowCustom: boolean;
  customLabel: string;
  summary: string;
};

export type SubTool = {
  id: string;
  callId: string;
  name: string;
  summary: string;
  status: "streaming" | "running" | "done" | "error" | "pending";
  args?: unknown;
  result?: string;
};

export type SubTranscriptItem =
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming?: boolean;
      reasoning?: string;
      reasoningStreaming?: boolean;
    }
  | { id: string; kind: "tool"; tool: SubTool };

export type SubNode = {
  id: string;
  goal: string;
  status: "running" | "done" | "error";
  summary?: string;
  role?: string;
  activity?: string;
  transcript: SubTranscriptItem[];
};

export type MsgAttachment = {
  name: string;
  path: string;
  kind?: string;
};

export type ChatMsg = {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "subagent";
  content: string;
  streaming?: boolean;
  reasoning?: string;
  reasoningStreaming?: boolean;
  tool?: ToolCard;
  subagent?: SubNode;
  /** Uploaded files shown as chips in the bubble (not the full model payload). */
  attachments?: MsgAttachment[];
};

export type LiveLine = { id: string; text: string; kind: string };
export type SettingsTab = "workspace" | "model" | "mcp" | "runtime" | "appearance" | "account";

export type QueuedMsg = {
  id: string;
  text: string;
  userDisplay?: string;
  attachments?: MsgAttachment[];
};

export type PendingConfirm = {
  key: string;
  title: string;
  detail?: string;
  confirmLabel?: string;
  run: () => void | Promise<void>;
};

export type DetailView =
  | { type: "tool"; tool: ToolCard }
  | { type: "subagent"; subagent: SubNode }
  | { type: "changes"; selectedPath: string | null }
  | {
      type: "file";
      path: string;
      content: string;
      dirty?: boolean;
      kind: string;
      mime?: string;
      size?: number;
      preview?: string;
      editable?: boolean;
      message?: string;
      rawUrl?: string;
      highlightQuery?: string;
      focusLine?: number;
      forceEdit?: boolean;
    }
  | null;

export const ASK_CUSTOM_KEY = "custom";

export const FS_MUTATING_TOOLS = new Set([
  "write_file",
  "str_replace",
  "delete_file",
  "run_shell",
  "skill_save",
]);

export const ATTACH_MARKER = "用户上传了以下附件，请根据附件内容进行分析与回答：";
