import {
  browseWorkspace,
  deleteSession,
  fetchHealth,
  fetchMemory,
  fetchModel,
  fetchSession,
  fetchSessions,
  fetchSkills,
  fetchWorkspaces,
  HISTORY_PAGE_SIZE,
  readFileContent,
  saveSession,
  setWorkspace,
  truncateSession,
  uploadFile,
  type Health,
  type SkillItem,
} from "../api";
import { stripTrailingAtQuery } from "../components/AtFileMenu";
import {
  formatHelpText,
  parseSlashLine,
  resolveSlashRoute,
  type SlashMenuItem,
} from "../slash/commands";
import type {
  ApprovalPrompt,
  AskPrompt,
  ChatMsg,
  DetailView,
  MsgAttachment,
  PendingConfirm,
  SettingsTab,
} from "../types/chat";
import { uid } from "../utils/chatHelpers";
import { modelLabel } from "../types/modelSetup";
import type { ModelSetup } from "../types/modelSetup";
import type { MsgKey, Locale } from "../i18n";

export type MessageActionsDeps = {
  t: (key: MsgKey, ...args: string[]) => string;
  locale: Locale;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  attachments: {
    id: string;
    name: string;
    path: string;
    kind: string;
    text?: string;
    size?: number;
  }[];
  setAttachments: React.Dispatch<
    React.SetStateAction<
      {
        id: string;
        name: string;
        path: string;
        kind: string;
        text?: string;
        size?: number;
      }[]
    >
  >;
  attachBusy: boolean;
  setAttachBusy: (v: boolean) => void;
  attachInputRef: React.RefObject<HTMLInputElement | null>;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  sessionId: string | null;
  sessionIdRef: React.MutableRefObject<string | null>;
  sessionsPage: number;
  skills: SkillItem[];
  setSkills: (s: SkillItem[]) => void;
  memory: string;
  setMemory: (m: string) => void;
  model: ModelSetup | null;
  health: Health | null;
  stats: { tokens: number; iters: number };
  ctx: { tokens: number; limit: number };
  activeWs: { path: string; name: string } | null;
  setActiveWs: (w: { path: string; name: string } | null) => void;
  setWorkspaces: (w: import("../api").WorkspaceItem[]) => void;
  setHealth: (h: Health | null) => void;
  setModel: (m: ModelSetup | null) => void;
  setWsBusy: (v: boolean) => void;
  setFsRefresh: React.Dispatch<React.SetStateAction<number>>;
  setToast: React.Dispatch<React.SetStateAction<string>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessions: React.Dispatch<React.SetStateAction<import("../api").SessionItem[]>>;
  setSessionsPage: React.Dispatch<React.SetStateAction<number>>;
  setSessionsTotal: React.Dispatch<React.SetStateAction<number>>;
  setSessionsTotalPages: React.Dispatch<React.SetStateAction<number>>;
  setSidePanel: (p: "files" | "search" | "history" | "browser") => void;
  setExplorerCollapsed: (v: boolean) => void;
  setDetail: React.Dispatch<React.SetStateAction<DetailView>>;
  setLive: React.Dispatch<React.SetStateAction<import("../types/chat").LiveLine[]>>;
  setSubs: React.Dispatch<React.SetStateAction<import("../types/chat").SubNode[]>>;
  setApproval: React.Dispatch<React.SetStateAction<ApprovalPrompt | null>>;
  setAskPrompt: React.Dispatch<React.SetStateAction<AskPrompt | null>>;
  setAskChoice: React.Dispatch<React.SetStateAction<string>>;
  setAskOtherText: React.Dispatch<React.SetStateAction<string>>;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditDraft: React.Dispatch<React.SetStateAction<string>>;
  setEditRestorePrompt: React.Dispatch<
    React.SetStateAction<{ msgId: string; text: string; keepUserTurns: number } | null>
  >;
  editDraft: string;
  editRestorePrompt: { msgId: string; text: string; keepUserTurns: number } | null;
  setCopiedId: React.Dispatch<React.SetStateAction<string | null>>;
  openSettings: (tab?: SettingsTab) => void;
  openMemory: () => void;
  openChat: () => void;
  openHistoryPanel: () => void;
  refreshSessions: (page?: number) => Promise<void>;
  applySessionDetail: (detail: import("../api").SessionDetail) => void;
  resetContextUsage: () => void;
  commit: (next: ChatMsg[]) => void;
  appendMsg: (msg: ChatMsg) => void;
  transcriptRef: React.MutableRefObject<ChatMsg[]>;
  busyRef: React.MutableRefObject<boolean>;
  streamIdRef: React.MutableRefObject<string | null>;
  streamTextRef: React.MutableRefObject<string>;
  streamReasoningRef: React.MutableRefObject<string>;
  nativeReasoningRef: React.MutableRefObject<boolean>;
  enqueueMessage: (
    text: string,
    opts?: { userDisplay?: string; attachments?: MsgAttachment[] },
  ) => void;
  clearQueued: () => void;
  sendChat: (
    msg: string,
    opts?: {
      showUser?: boolean;
      userDisplay?: string;
      attachments?: MsgAttachment[];
      mode?: "plan" | "agent";
    },
  ) => Promise<void>;
  stopChat: () => Promise<void>;
  detachListener: () => void;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useMessageActions(deps: MessageActionsDeps) {
  const {
    t, locale, input, setInput, attachments, setAttachments, attachBusy, setAttachBusy,
    attachInputRef, composerRef, busy, sessionId, sessionIdRef, sessionsPage, skills, setSkills,
    memory, setMemory, model, health, stats, ctx, activeWs, setActiveWs, setWorkspaces,
    setHealth, setModel, setWsBusy, setFsRefresh, setToast, setSessionId, setSessions, setSessionsPage,
    setSessionsTotal, setSessionsTotalPages, setSidePanel, setExplorerCollapsed, setDetail,
    setLive, setSubs, setApproval, setAskPrompt, setAskChoice, setAskOtherText,
    setEditingId, setEditDraft, setEditRestorePrompt, editDraft, editRestorePrompt,
    setCopiedId, openSettings, openMemory, openChat, openHistoryPanel, refreshSessions, applySessionDetail,
    resetContextUsage, commit, appendMsg, transcriptRef, busyRef, streamIdRef,
    streamTextRef, streamReasoningRef, nativeReasoningRef, enqueueMessage, clearQueued,
    sendChat, stopChat, detachListener, setBusy,
  } = deps;

async function applyAtFile(item: { path: string; name: string; kind?: string }) {
  setInput(stripTrailingAtQuery(input));
  if (!activeWs?.path) {
    setToast(t("pickWorkspaceToast"));
    openSettings("workspace");
    return;
  }
  setAttachBusy(true);
  try {
    const data = await readFileContent(item.path);
    const text =
      typeof data.content === "string"
        ? data.content
        : typeof data.preview === "string"
          ? data.preview
          : "";
    setAttachments((prev) => [
      ...prev,
      {
        id: uid(),
        name: data.name || item.name,
        path: data.path || item.path,
        kind: String(data.kind || item.kind || "file"),
        text: text.slice(0, 12000),
        size: data.size,
      },
    ]);
    setToast(t("composerAtAdded"));
  } catch (e) {
    setToast(e instanceof Error ? e.message : String(e));
  } finally {
    setAttachBusy(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
}

function postSystem(content: string) {
  appendMsg({ id: uid(), role: "system", content });
}

function findSkill(query: string): SkillItem | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    skills.find((s) => s.name.toLowerCase() === q || s.tool.toLowerCase() === q) ||
    skills.find(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.tool.toLowerCase().includes(q) ||
        s.tool.toLowerCase().endsWith(`_${q}`),
    )
  );
}

/** Split `/skill <name> [task…]` — name may be matched as longest known skill prefix. */
function resolveSkillInvocation(
  args: string,
  list: SkillItem[],
): { skill: SkillItem; task: string } | null {
  const raw = args.trim();
  if (!raw) return null;

  const findExact = (q: string) => {
    const key = q.trim().toLowerCase();
    if (!key) return undefined;
    return (
      list.find((s) => s.name.toLowerCase() === key || s.tool.toLowerCase() === key) ||
      list.find((s) => s.tool.toLowerCase() === `skill_${key}`)
    );
  };

  // 1) Exact match on full string (skill names with spaces, if any)
  const full = findExact(raw);
  if (full) return { skill: full, task: "" };

  // 2) Longest known name/tool as prefix, then remaining text = task
  const lower = raw.toLowerCase();
  type Cand = { skill: SkillItem; key: string };
  const cands: Cand[] = [];
  for (const s of list) {
    for (const key of [s.name, s.tool, s.tool.replace(/^skill_/i, "")]) {
      const k = (key || "").trim();
      if (!k) continue;
      const kl = k.toLowerCase();
      if (lower === kl || lower.startsWith(`${kl} `) || lower.startsWith(`${kl}\t`)) {
        cands.push({ skill: s, key: k });
      }
    }
  }
  cands.sort((a, b) => b.key.length - a.key.length);
  if (cands.length) {
    const best = cands[0];
    return { skill: best.skill, task: raw.slice(best.key.length).trim() };
  }

  // 3) First token = name, rest = task
  const sp = raw.search(/\s/);
  const name = sp < 0 ? raw : raw.slice(0, sp);
  const task = sp < 0 ? "" : raw.slice(sp + 1).trim();
  const sk =
    findExact(name) ||
    list.find(
      (s) =>
        s.name.toLowerCase().includes(name.toLowerCase()) ||
        s.tool.toLowerCase().includes(name.toLowerCase()),
    );
  if (!sk) return null;
  return { skill: sk, task };
}

async function runSlashCommand(raw: string): Promise<boolean> {
  const parsed = parseSlashLine(raw);
  if (!parsed) return false;
  const { name, args } = parsed;
  if (!name) {
    postSystem(formatHelpText(locale));
    return true;
  }
  const def = resolveSlashRoute(name);
  if (!def) {
    postSystem(`未知命令 \`/${name}\`。输入 \`/help\` 查看可用命令。`);
    return true;
  }

  switch (def.id) {
    case "help":
      postSystem(formatHelpText(locale));
      return true;
    case "new":
      await newChat();
      return true;
    case "stop":
      if (busy) await stopChat();
      else setToast("当前没有进行中的任务");
      return true;
    case "clear": {
      commit([]);
      setLive([]);
      setSubs([]);
      setDetail(null);
      clearQueued();
      setAttachments([]);
      if (sessionId) {
        try {
          // Persist empty transcript so refresh won't restore old messages.
          await truncateSession(sessionId, 0);
          setToast(t("chatCleared"));
        } catch (e) {
          setToast(e instanceof Error ? e.message : String(e));
        }
      } else {
        setToast(t("chatCleared"));
      }
      return true;
    }
    case "history":
      openHistoryPanel();
      return true;
    case "save": {
      if (!sessionId) {
        setToast("当前没有可保存的会话");
        return true;
      }
      try {
        const res = await saveSession(sessionId);
        postSystem(`会话已保存${res.path ? `：\`${res.path}\`` : ""}`);
        await refreshSessions();
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
      return true;
    }
    case "skills": {
      const list = skills.length
        ? skills
        : await fetchSkills().then((s) => {
            setSkills(s);
            return s;
          });
      if (!list.length) {
        postSystem("暂无 Skills。可在 `skills/` 下添加 `SKILL.md`。");
      } else {
        const body = [
          `共 ${list.length} 个 Skill（输入 \`/skill <名称> [指令]\` 调用）：`,
          "",
          ...list.map((s) => `- **${s.name}** · \`${s.tool}\`\n  ${s.description || "（无描述）"}`),
        ].join("\n");
        postSystem(body);
      }
      return true;
    }
    case "skill": {
      if (!args) {
        postSystem("用法：`/skill <名称> [指令]`。先用 `/skills` 查看列表。");
        return true;
      }
      let list = skills;
      let resolved = resolveSkillInvocation(args, list);
      if (!resolved) {
        try {
          list = await fetchSkills();
          setSkills(list);
          resolved = resolveSkillInvocation(args, list);
        } catch {
          /* ignore */
        }
      }
      if (!resolved) {
        const nameHint = args.trim().split(/\s+/)[0] || args;
        postSystem(`未找到 Skill：\`${nameHint}\`。输入 \`/skills\` 查看全部。`);
        return true;
      }
      const { skill: sk, task } = resolved;
      // Prefer a short tool-call instruction. The skill_* tool already returns the
      // SKILL.md body — do NOT paste the whole document into the user message
      // (that polluted context and Demo mode just echoed the injection text).
      const prompt = [
        `请立即调用函数工具 \`${sk.tool}\`${
          task ? `，task 参数为：${task}` : "（可省略 task，按该 Skill 的标准流程执行）"
        }。`,
        "调用后严格按工具返回的流程继续使用 write_file / run_shell 等工具完成任务，",
        "不要只复述 Skill 正文，也不要声称「没有这个技能」。",
      ].join("");
      if (busyRef.current) {
        enqueueMessage(prompt);
        setToast("Skill 已加入队列，当前任务结束后执行。");
      } else {
        await sendChat(prompt, {
          showUser: true,
          userDisplay: task ? `/skill ${sk.name} ${task}` : `/skill ${sk.name}`,
        });
      }
      return true;
    }
    case "memory": {
      const sub = args.toLowerCase();
      if (sub === "refresh") {
        const text = await fetchMemory();
        setMemory(text);
        setToast("记忆已刷新。");
        return true;
      }
      openMemory();
      return true;
    }
    case "model":
      openSettings("model");
      return true;
    case "workspace":
      openSettings("workspace");
      return true;
    case "runtime":
      openSettings("runtime");
      return true;
    case "stats":
      postSystem(
        [
          `**上下文** ${ctx.tokens} / ${ctx.limit} tokens（{Math.min(100, Math.round((ctx.tokens / Math.max(1, ctx.limit)) * 100))}%）`,
          `**迭代** ${stats.iters}`,
          `**模型** ${health?.model || modelLabel(model, model?.main) || "—"}`,
          `**工作区** ${activeWs?.path || "未选择"}`,
          `**会话** ${sessionId || "—"}`,
        ].join("\n"),
      );
      return true;
    case "files":
      setSidePanel("files");
      setExplorerCollapsed(false);
      setToast("已展开文件浏览器。");
      return true;
    case "browser":
      setSidePanel("browser");
      setExplorerCollapsed(false);
      setToast(t("navBrowser"));
      return true;
    case "settings":
      openSettings(args === "model" ? "model" : "workspace");
      return true;
    default:
      postSystem(`命令 \`/${def.name}\` 尚未实现。`);
      return true;
  }
}

function applySlashItem(item: SlashMenuItem) {
  // `/skill` / commands that still need user input: fill composer, do not send.
  if (item.needsArgs && item.kind === "command" && !item.args) {
    setInput(item.insert.endsWith(" ") ? item.insert : `${item.insert} `);
    requestAnimationFrame(() => composerRef.current?.focus());
    return;
  }
  if (item.kind === "skill") {
    const args = String(item.args || "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    // Only the skill name — wait for the user to type 指令 before sending.
    if (parts.length <= 1) {
      const name =
        parts[0] ||
        item.insert.replace(/^\/skill\s+/i, "").trim().split(/\s+/)[0] ||
        "";
      if (!name) return;
      setInput(`/skill ${name} `);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
  }
  const line = item.insert.trim();
  setInput("");
  // Re-focus so the next `/` can open the menu again in the same turn.
  requestAnimationFrame(() => composerRef.current?.focus());
  void (async () => {
    const parsed = parseSlashLine(line);
    // `/skill` shows the injected Skill markdown instead of the raw slash line.
    if (parsed?.name !== "skill") {
      appendMsg({ id: uid(), role: "user", content: line });
    }
    try {
      await runSlashCommand(line);
    } catch (e) {
      postSystem(`命令执行失败：${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

async function newChat() {
  sessionIdRef.current = null;
  detachListener();
  clearQueued();
  setAttachments([]);
  streamIdRef.current = null;
  streamTextRef.current = "";
  streamReasoningRef.current = "";
  nativeReasoningRef.current = false;
  commit([]);
  setLive([]);
  setSubs([]);
  setDetail(null);
  setApproval(null);
  setAskPrompt(null);
  setAskChoice("");
  setAskOtherText("");
  resetContextUsage();
  setBusy(false);
  setSessionId(null);
  setToast(t("chatDraftStarted"));
  void refreshSessions(1);
}

async function openSession(id: string) {
  if (id === sessionIdRef.current) {
    return;
  }
  sessionIdRef.current = id;
  detachListener();
  clearQueued();
  setBusy(false);
  const detailSession = await fetchSession(id);
  applySessionDetail(detailSession);
  {
    const rawTitle = (detailSession.title || "").trim();
    const titleLabel =
      !rawTitle || rawTitle === "新会话" || rawTitle === "New chat" || rawTitle === "Untitled"
        ? t("sessionUntitled")
        : rawTitle;
    setToast(t("historyOpened", titleLabel));
  }
}

async function switchWorkspace(path: string, create = false) {
  const res = await setWorkspace(path, create);
  setActiveWs(res.active?.path ? res.active : null);
  setWorkspaces(res.items);
  setHealth(await fetchHealth());
  try {
    setModel(await fetchModel());
  } catch {
    /* keep previous model if reload fails */
  }
  setFsRefresh((n) => n + 1);
  setSessions([]);
  setSessionsPage(1);
  setSessionsTotal(0);
  setSessionsTotalPages(1);
  await newChat();
  setToast(`工作区：${res.active.path}`);
}

async function browseAndSetWorkspace() {
  setWsBusy(true);
  try {
    const res = await browseWorkspace();
    if (res.cancelled || !res.path) {
      setToast("已取消选择");
      return;
    }
    await switchWorkspace(res.path);
  } catch (e) {
    setToast(e instanceof Error ? e.message : String(e));
  } finally {
    setWsBusy(false);
  }
}

async function removeSession(id: string) {
  await deleteSession(id);
  if (sessionIdRef.current === id) {
    sessionIdRef.current = null;
    detachListener();
    clearQueued();
    commit([]);
    setLive([]);
    setSubs([]);
    setDetail(null);
    setApproval(null);
    setAskPrompt(null);
    resetContextUsage();
    setBusy(false);
    setSessionId(null);
  }
  const res = await fetchSessions(sessionsPage, HISTORY_PAGE_SIZE);
  if ((res.items || []).length === 0 && sessionsPage > 1) {
    await refreshSessions(sessionsPage - 1);
  } else {
    setSessions(res.items || []);
    setSessionsPage(res.page || 1);
    setSessionsTotal(res.total || 0);
    setSessionsTotalPages(res.total_pages || 1);
  }
  setToast("已删除对话。");
}

async function copyBubble(id: string, text: string) {
  const body = (text || "").trim();
  if (!body) {
    setToast("没有可复制的内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(body);
    setCopiedId(id);
    setToast("已复制。");
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
  } catch {
    setToast("复制失败");
  }
}

function startEditUser(id: string, content: string) {
  if (busyRef.current) {
    setToast("请先等待当前回复结束，或点击停止");
    return;
  }
  setEditingId(id);
  setEditDraft(content);
  setEditRestorePrompt(null);
}

function cancelEdit() {
  setEditingId(null);
  setEditDraft("");
  setEditRestorePrompt(null);
}

function requestSubmitEdit(msgId: string) {
  const text = editDraft.trim();
  if (!text) {
    setToast(t("editEmpty"));
    return;
  }
  if (busyRef.current) {
    setToast(t("editBusy"));
    return;
  }
  const list = transcriptRef.current;
  const msgIndex = list.findIndex((m) => m.id === msgId);
  if (msgIndex < 0) return;
  let keepUserTurns = 0;
  for (let i = 0; i < msgIndex; i++) {
    if (list[i].role === "user") keepUserTurns += 1;
  }
  setEditRestorePrompt({ msgId, text, keepUserTurns });
}

async function submitEdit(msgId: string, restoreFiles: boolean) {
  const pending = editRestorePrompt;
  const text = (pending?.msgId === msgId ? pending.text : editDraft).trim();
  if (!text) {
    setToast(t("editEmpty"));
    return;
  }
  if (busyRef.current) {
    setToast(t("editBusy"));
    return;
  }
  const list = transcriptRef.current;
  const msgIndex = list.findIndex((m) => m.id === msgId);
  if (msgIndex < 0) return;
  let keepUserTurns =
    pending?.msgId === msgId ? pending.keepUserTurns : 0;
  if (pending?.msgId !== msgId) {
    keepUserTurns = 0;
    for (let i = 0; i < msgIndex; i++) {
      if (list[i].role === "user") keepUserTurns += 1;
    }
  }
  setEditRestorePrompt(null);
  commit(list.slice(0, msgIndex));
  setEditingId(null);
  setEditDraft("");
  setDetail(null);
  setSubs([]);
  setLive([]);
  setApproval(null);
  setAskPrompt(null);
  setAskChoice("");
  setAskOtherText("");
  if (sessionId) {
    try {
      const res = await truncateSession(sessionId, keepUserTurns, {
        restoreFiles,
      });
      if (restoreFiles) {
        setFsRefresh((n) => n + 1);
        const n = res.file_undo?.undone_count ?? 0;
        if (res.file_undo?.partial) {
          setToast(t("editRestorePartial", String(n)));
        } else if (n > 0) {
          setToast(t("editRestoreOk", String(n)));
        } else {
          setToast(t("editRestoreNone"));
        }
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  await sendChat(text);
}

async function addAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!activeWs?.path) {
      setToast(t("pickWorkspaceToast"));
      openSettings("workspace");
      return;
    }
    setAttachBusy(true);
    try {
      const next = [...attachments];
      for (const file of Array.from(files)) {
        const uploaded = await uploadFile(file);
        const text =
          typeof uploaded.content === "string"
            ? uploaded.content
            : typeof uploaded.preview === "string"
              ? uploaded.preview
              : "";
        next.push({
          id: uid(),
          name: uploaded.name || file.name,
          path: uploaded.path,
          kind: String(uploaded.kind || "file"),
          text: text.slice(0, 12000),
          size: uploaded.size ?? file.size,
        });
      }
      setAttachments(next);
      setFsRefresh((n) => n + 1);
      setToast(t("composerAttach"));
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setAttachBusy(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  function buildMessageWithAttachments(userText: string) {
    if (attachments.length === 0) return userText;
    const blocks = attachments.map((a) => {
      if (a.kind === "dom-element" && a.text?.trim()) {
        return a.text.trim();
      }
      const head = `### 附件：${a.name}\n路径：\`${a.path}\``;
      if (a.text?.trim()) {
        return `${head}\n\`\`\`\n${a.text.trim()}\n\`\`\``;
      }
      return `${head}\n${t("attachBinary")}`;
    });
    const hasDom = attachments.some((a) => a.kind === "dom-element");
    const attachBlock = [
      hasDom
        ? "用户附带了页面元素（Select Mode）和/或文件，请按意图修改源码并回答。"
        : "用户上传了以下附件，请根据附件内容进行分析与回答。",
      "",
      ...blocks,
    ].join("\n");
    return userText.trim() ? `${userText.trim()}\n\n${attachBlock}` : attachBlock;
  }


async function send(text?: string) {
  const raw = (text ?? input).trim();
  const hasAttach = attachments.length > 0 && text === undefined;
  if (!raw && !hasAttach) return;

  if (busyRef.current) {
    if (raw === "/stop" || raw.startsWith("/stop ")) {
      setInput("");
      await stopChat();
      return;
    }
    if (raw.startsWith("/")) {
      const parsed = parseSlashLine(raw);
      const localIds = new Set([
        "help",
        "stop",
        "clear",
        "history",
        "save",
        "skills",
        "skill",
        "memory",
        "model",
        "workspace",
        "runtime",
        "stats",
        "files",
        "browser",
        "settings",
        "new",
      ]);
      if (parsed && localIds.has(resolveSlashRoute(parsed.name)?.id || parsed.name)) {
        const def = resolveSlashRoute(parsed.name);
        if (def?.id === "skill") {
          setInput("");
          await runSlashCommand(raw);
          return;
        }
        if (def?.id === "new" || def?.id === "stop") {
          setInput("");
          appendMsg({ id: uid(), role: "user", content: raw });
          await runSlashCommand(raw);
          return;
        }
        setInput("");
        appendMsg({ id: uid(), role: "user", content: raw });
        await runSlashCommand(raw);
        return;
      }
    }
    const attachMeta = hasAttach
      ? attachments.map((a) => ({ name: a.name, path: a.path, kind: a.kind }))
      : undefined;
    const payload = hasAttach ? buildMessageWithAttachments(raw) : raw;
    enqueueMessage(payload, { userDisplay: raw, attachments: attachMeta });
    if (hasAttach) setAttachments([]);
    return;
  }

  if ((raw.startsWith("/") || raw.startsWith("／")) && !hasAttach) {
    const line = raw.replace(/^／/, "/");
    const parsed = parseSlashLine(line);
    setInput("");
    if (parsed?.name !== "skill") {
      appendMsg({ id: uid(), role: "user", content: line });
    }
    try {
      await runSlashCommand(line);
    } catch (e) {
      postSystem(`命令执行失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const attachMeta = hasAttach
    ? attachments.map((a) => ({ name: a.name, path: a.path, kind: a.kind }))
    : undefined;
  const payload = hasAttach ? buildMessageWithAttachments(raw) : raw;
  setAttachments([]);
  await sendChat(payload, {
    showUser: true,
    userDisplay: raw,
    attachments: attachMeta,
  });
}
  return {
    applyAtFile,
    postSystem,
    findSkill,
    runSlashCommand,
    applySlashItem,
    newChat,
    openSession,
    switchWorkspace,
    browseAndSetWorkspace,
    removeSession,
    copyBubble,
    startEditUser,
    cancelEdit,
    requestSubmitEdit,
    submitEdit,
    addAttachments,
    buildMessageWithAttachments,
    send,
  };
}
