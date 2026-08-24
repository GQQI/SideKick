import { useRef } from "react";
import {
  answerAsk,
  attachSessionEvents,
  confirmPlan,
  decideApproval,
  fetchMemory,
  fetchSession,
  fetchSkills,
  stopSession,
  streamChat,
  type RuntimeEvent,
  type SessionDetail,
  type SkillItem,
} from "../api";
import type { ActivePlan } from "../components/TaskPlanPanel";
import {
  ASK_CUSTOM_KEY,
  type ApprovalPrompt,
  type AskPrompt,
  type ChatMsg,
  type DetailView,
  type LiveLine,
  type MsgAttachment,
  type QueuedMsg,
  type SettingsTab,
  type SubNode,
  type SubTranscriptItem,
  type ToolCard,
} from "../types/chat";
import type { PlanConfirmState } from "../types/plan";
import { ThinkTagSplitter, splitThinkTags } from "../utils/thinkTags";
import { mapSessionMessages, uid } from "../utils/chatHelpers";
import type { MsgKey } from "../i18n";
import { handleRuntimeEvent } from "./chat/handleRuntimeEvent";
import {
  upsertToolDelta,
  upsertToolEnd,
  upsertToolStart,
  type ToolUpsertCtx,
} from "./chat/toolUpserts";

export type ChatStreamDeps = {
  t: (key: MsgKey, ...args: string[]) => string;
  locale: string;
  sessionId: string | null;
  sessionIdRef: React.MutableRefObject<string | null>;
  activeWs: { path: string; name: string } | null;
  chatMode: "plan" | "agent";
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setLive: React.Dispatch<React.SetStateAction<LiveLine[]>>;
  setSubs: React.Dispatch<React.SetStateAction<SubNode[]>>;
  setDetail: React.Dispatch<React.SetStateAction<DetailView>>;
  setCtx: React.Dispatch<React.SetStateAction<{ tokens: number; limit: number }>>;
  setCompressState: React.Dispatch<
    React.SetStateAction<{
      active: boolean;
      message: string;
      attempt: number;
      maxAttempts: number;
      before: number;
      after?: number;
    } | null>
  >;
  setActivePlan: React.Dispatch<React.SetStateAction<ActivePlan | null>>;
  setPlanConfirm: React.Dispatch<React.SetStateAction<PlanConfirmState | null>>;
  setApproval: React.Dispatch<React.SetStateAction<ApprovalPrompt | null>>;
  setAskPrompt: React.Dispatch<React.SetStateAction<AskPrompt | null>>;
  setAskChoice: React.Dispatch<React.SetStateAction<string>>;
  setAskOtherText: React.Dispatch<React.SetStateAction<string>>;
  setFsRefresh: React.Dispatch<React.SetStateAction<number>>;
  setToast: React.Dispatch<React.SetStateAction<string>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setStats: React.Dispatch<React.SetStateAction<{ tokens: number; iters: number }>>;
  setSkills: React.Dispatch<React.SetStateAction<SkillItem[]>>;
  setMemory: React.Dispatch<React.SetStateAction<string>>;
  setSettingsTab: (tab: SettingsTab) => void;
  setSettingsOpen: (v: boolean) => void;
  setQueued: React.Dispatch<React.SetStateAction<QueuedMsg[]>>;
  approval: ApprovalPrompt | null;
  askPrompt: AskPrompt | null;
  planConfirm: PlanConfirmState | null;
  stickBottomRef: React.MutableRefObject<boolean>;
  askPendingRef: React.MutableRefObject<boolean>;
  planPendingRef: React.MutableRefObject<boolean>;
  executingPlanIdRef: React.MutableRefObject<string | null>;
  refreshSessionsRef: React.MutableRefObject<(page?: number) => Promise<void>>;
};

export function useChatStream(deps: ChatStreamDeps) {
  const {
    t,
    locale,
    sessionId,
    sessionIdRef,
    activeWs,
    chatMode,
    setMessages,
    setInput,
    setBusy,
    setLive,
    setSubs,
    setDetail,
    setCtx,
    setCompressState,
    setActivePlan,
    setPlanConfirm,
    setApproval,
    setAskPrompt,
    setAskChoice,
    setAskOtherText,
    setFsRefresh,
    setToast,
    setSessionId,
    setStats,
    setSkills,
    setMemory,
    setSettingsTab,
    setSettingsOpen,
    setQueued,
    approval,
    askPrompt,
    planConfirm,
    stickBottomRef,
    askPendingRef,
    planPendingRef,
    executingPlanIdRef,
    refreshSessionsRef,
  } = deps;

  const openSettings = (tab: SettingsTab = "workspace") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const transcriptRef = useRef<ChatMsg[]>([]);
  const streamIdRef = useRef<string | null>(null);
  const streamTextRef = useRef("");
  const streamReasoningRef = useRef("");
  const nativeReasoningRef = useRef(false);
  const thinkSplitRef = useRef(new ThinkTagSplitter());
  const abortRef = useRef<AbortController | null>(null);
  const stoppingRef = useRef(false);
  const turnDoneRef = useRef(false);
  const queuedRef = useRef<QueuedMsg[]>([]);
  const busyRef = useRef(false);

  function commit(next: ChatMsg[]) {
  transcriptRef.current = next;
  setMessages(next);
}

function appendMsg(msg: ChatMsg) {
  commit([...transcriptRef.current, msg]);
}

function updateMsg(id: string, patch: Partial<ChatMsg>) {
  commit(transcriptRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m)));
}

/** Keep the open tool detail panel in sync when status/callId advances. */
function syncToolPanel(tool: ToolCard, prevCallId?: string) {
  setDetail((d) => {
    if (d?.type !== "tool") return d;
    const same =
      d.tool.id === tool.id ||
      d.tool.callId === tool.callId ||
      (prevCallId != null &&
        prevCallId !== "" &&
        d.tool.callId === prevCallId) ||
      (Boolean(d.tool.name) &&
        d.tool.name === tool.name &&
        (d.tool.status === "streaming" ||
          d.tool.status === "running" ||
          d.tool.status === "pending") &&
        (tool.status === "running" ||
          tool.status === "pending" ||
          tool.status === "done" ||
          tool.status === "error"));
    return same ? { type: "tool", tool } : d;
  });
}

function findToolMsg(opts: {
  callId?: string;
  name?: string;
  statuses?: ToolCard["status"][];
}): ChatMsg | undefined {
  const callId = opts.callId || "";
  const name = opts.name || "";
  const statuses = opts.statuses;
  const list = transcriptRef.current;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== "tool" || !m.tool) continue;
    if (callId && m.tool.callId === callId) return m;
    if (
      name &&
      m.tool.name === name &&
      (!statuses || statuses.includes(m.tool.status))
    ) {
      return m;
    }
  }
  return undefined;
}

function setBusyState(v: boolean) {
  busyRef.current = v;
  setBusy(v);
}

function setQueuedState(next: QueuedMsg[]) {
  queuedRef.current = next;
  setQueued(next);
}

function enqueueMessage(
  text: string,
  opts?: { userDisplay?: string; attachments?: MsgAttachment[] },
) {
  const item: QueuedMsg = {
    id: uid(),
    text,
    userDisplay: opts?.userDisplay,
    attachments: opts?.attachments,
  };
  setQueuedState([...queuedRef.current, item]);
  setInput("");
  setToast("已加入队列，当前任务结束后发送。");
}

function removeQueued(id: string) {
  setQueuedState(queuedRef.current.filter((q) => q.id !== id));
}

function clearQueued() {
  setQueuedState([]);
}

function updateSubagentMsg(childId: string, patch: Partial<SubNode>) {
  const hit = transcriptRef.current.find(
    (m) => m.role === "subagent" && m.subagent?.id === childId,
  );
  if (!hit?.subagent) return;
  const subagent = { ...hit.subagent, ...patch };
  updateMsg(hit.id, {
    subagent,
    content: subagent.summary || subagent.goal,
  });
  setSubs((prev) => prev.map((s) => (s.id === childId ? { ...s, ...patch } : s)));
  setDetail((d) =>
    d?.type === "subagent" && d.subagent.id === childId ? { type: "subagent", subagent } : d,
  );
}

function patchSubagent(
  childId: string,
  fn: (s: SubNode) => SubNode,
) {
  const hit = transcriptRef.current.find(
    (m) => m.role === "subagent" && m.subagent?.id === childId,
  );
  if (!hit?.subagent) return;
  const subagent = fn(hit.subagent);
  updateMsg(hit.id, {
    subagent,
    content: subagent.summary || subagent.goal,
  });
  setSubs((prev) => prev.map((s) => (s.id === childId ? { ...s, ...subagent } : s)));
  setDetail((d) =>
    d?.type === "subagent" && d.subagent.id === childId ? { type: "subagent", subagent } : d,
  );
}

function sealSubassistant(transcript: SubTranscriptItem[]): SubTranscriptItem[] {
  const tr = [...transcript];
  const last = tr[tr.length - 1];
  if (last?.kind === "assistant" && last.streaming) {
    tr[tr.length - 1] = { ...last, streaming: false };
  }
  return tr;
}

function looksLikeOptionList(text: string): boolean {
  const lines = text
    .split("\n")
    .filter((line) => /^\s*(\d+|[A-Za-z])[\.\)、：]\s*.+/.test(line));
  return lines.length >= 2;
}

function discardStreamBubble() {
  const id = streamIdRef.current;
  if (id) {
    commit(transcriptRef.current.filter((m) => m.id !== id));
  }
  streamIdRef.current = null;
  streamTextRef.current = "";
  streamReasoningRef.current = "";
  nativeReasoningRef.current = false;
  thinkSplitRef.current.reset();
}

function stripDuplicateAskBubble(question: string) {
  discardStreamBubble();
  const q = question.trim();
  const qHead = q.slice(0, Math.min(80, q.length));
  for (let i = transcriptRef.current.length - 1; i >= 0; i--) {
    const m = transcriptRef.current[i];
    if (m.role !== "assistant") continue;
    if (m.tool) break;
    const text = (m.content || "").trim();
    if (!text) break;
    const sameQuestion = Boolean(
      qHead &&
        (text.includes(qHead) ||
          (text.length >= 24 && q.includes(text.slice(0, Math.min(80, text.length))))),
    );
    if (looksLikeOptionList(text) || sameQuestion) {
      commit(transcriptRef.current.filter((x) => x.id !== m.id));
    }
    break;
  }
}

function sealStreamBubble() {
  const id = streamIdRef.current;
  if (!id) return;
  // Flush any buffered partial <think> tag leftovers
  for (const p of thinkSplitRef.current.flush()) {
    if (p.kind === "reasoning") streamReasoningRef.current += p.text;
    else streamTextRef.current += p.text;
  }
  thinkSplitRef.current.reset();
  const text = streamTextRef.current;
  const reasoning = streamReasoningRef.current;
  if (text.trim() || reasoning.trim()) {
    updateMsg(id, {
      content: text,
      reasoning: reasoning || undefined,
      streaming: false,
      reasoningStreaming: false,
    });
  } else {
    commit(transcriptRef.current.filter((m) => m.id !== id));
  }
  streamIdRef.current = null;
  streamTextRef.current = "";
  streamReasoningRef.current = "";
  nativeReasoningRef.current = false;
}

function ensureStreamBubble(reset: boolean) {
  if (reset) sealStreamBubble();
  if (!streamIdRef.current) {
    // Reopen only when continuing the *same* LLM stream after tool_call_delta
    // sealed the bubble (reset=false). Explicit reset must always start a new
    // bubble — otherwise post-ask_user output appends to the first bubble.
    if (!reset) {
      for (let i = transcriptRef.current.length - 1; i >= 0; i--) {
        const m = transcriptRef.current[i];
        if (m.role === "tool" || m.role === "subagent") continue;
        if (m.role === "assistant") {
          streamIdRef.current = m.id;
          streamTextRef.current = m.content || "";
          streamReasoningRef.current = m.reasoning || "";
          updateMsg(m.id, {
            streaming: true,
            reasoningStreaming:
              Boolean(m.reasoning) && !(m.content || "").trim(),
          });
          return;
        }
        break;
      }
    }
    const id = uid();
    streamIdRef.current = id;
    streamTextRef.current = "";
    streamReasoningRef.current = "";
    nativeReasoningRef.current = false;
    thinkSplitRef.current.reset();
    appendMsg({
      id,
      role: "assistant",
      content: "",
      reasoning: "",
      streaming: true,
      reasoningStreaming: false,
    });
  }
}

function syncStreamBubble() {
  const id = streamIdRef.current!;
  updateMsg(id, {
    content: streamTextRef.current,
    reasoning: streamReasoningRef.current || undefined,
    streaming: true,
    reasoningStreaming:
      Boolean(streamReasoningRef.current) && !streamTextRef.current.trim(),
  });
}

function appendStreamChunk(chunk: string, reset = false, discard = false) {
  if (reset) {
    if (discard) discardStreamBubble();
    else sealStreamBubble();
  }
  if (!chunk) {
    // Pass reset through so a reset:true opener creates a *new* bubble
    // instead of reconnecting to an older sealed assistant message.
    if (!discard) ensureStreamBubble(reset);
    return;
  }
  ensureStreamBubble(reset);
  // Peel <think>…</think> out of content (models that embed thinking in content).
  // Skip tagged pieces once native reasoning_content has started this turn.
  for (const p of thinkSplitRef.current.feed(chunk)) {
    if (p.kind === "reasoning") {
      if (nativeReasoningRef.current) continue;
      streamReasoningRef.current += p.text;
    } else {
      streamTextRef.current += p.text;
    }
  }
  syncStreamBubble();
}

function appendReasoningChunk(chunk: string, reset = false) {
  ensureStreamBubble(reset);
  if (!chunk) return;
  // Native reasoning_content / reasoning field
  nativeReasoningRef.current = true;
  streamReasoningRef.current += chunk;
  syncStreamBubble();
}

function finalizeAssistant(text: string, opts?: { stopped?: boolean }) {
  if (turnDoneRef.current) return;
  turnDoneRef.current = true;
  for (const p of thinkSplitRef.current.flush()) {
    if (p.kind === "reasoning") streamReasoningRef.current += p.text;
    else streamTextRef.current += p.text;
  }
  thinkSplitRef.current.reset();
  const id = streamIdRef.current;
  const streamed = streamTextRef.current.trim();
  const incoming = (text || "").trim();
  const placeholder = "（已停止）";
  let body: string;
  if (opts?.stopped) {
    // Prefer already-streamed UI text; never replace it with the stop placeholder
    const existing =
      id
        ? (transcriptRef.current.find((m) => m.id === id)?.content || "").trim()
        : "";
    body =
      streamed ||
      existing ||
      (incoming && incoming !== placeholder ? incoming : "") ||
      placeholder;
  } else {
    body = incoming || streamed;
  }
  let reasoning = streamReasoningRef.current.trim();
  if (/<\/?think/i.test(body)) {
    const peeled = splitThinkTags(body);
    body = peeled.content.trim();
    // Prefer native reasoning; only keep tagged peel when none was streamed.
    if (peeled.reasoning && !nativeReasoningRef.current) {
      reasoning = `${reasoning}${peeled.reasoning}`.trim();
    }
  }
  if (!body && !opts?.stopped) {
    body = t("emptyRoundOutput");
  }
  if (id && transcriptRef.current.some((m) => m.id === id)) {
    updateMsg(id, {
      content: body,
      reasoning: reasoning || undefined,
      streaming: false,
      reasoningStreaming: false,
    });
  } else if (body) {
    appendMsg({
      id: uid(),
      role: "assistant",
      content: body,
      reasoning: reasoning || undefined,
    });
  }
  streamIdRef.current = null;
  streamTextRef.current = "";
  streamReasoningRef.current = "";
  nativeReasoningRef.current = false;
}

async function stopChat() {
  const pending = approval;
  const pendingAsk = askPrompt;
  const pendingPlan = planConfirm;
  // Clear UI immediately so the panel cannot stick
  setApproval(null);
  setAskPrompt(null);
  askPendingRef.current = false;
  setAskChoice("");
  setAskOtherText("");
  setPlanConfirm(null);
  planPendingRef.current = false;

  if (!busyRef.current && !abortRef.current) {
    // Chat already idle: only dismiss leftover prompts
    if (pending && sessionId) {
      try {
        await decideApproval(sessionId, pending.approvalId, false, false);
      } catch {
        /* ignore */
      }
      setToast("已取消待确认操作");
    }
    if (pendingAsk && (sessionIdRef.current || sessionId)) {
      try {
        await answerAsk(
          sessionIdRef.current || sessionId!,
          pendingAsk.askId,
          ASK_CUSTOM_KEY,
          "",
        );
      } catch {
        /* ignore */
      }
    }
    if (pendingPlan && (sessionIdRef.current || sessionId || pendingPlan.sessionId)) {
      try {
        await confirmPlan(
          pendingPlan.sessionId || sessionIdRef.current || sessionId!,
          pendingPlan.planId,
          { approved: false },
        );
      } catch {
        /* ignore */
      }
    }
    return;
  }

  stoppingRef.current = true;
  setToast("正在停止…");
  const sid = sessionId;
  // Server cancel also rejects pending approvals — do not double-call decide here
  if (sid) {
    try {
      await stopSession(sid);
    } catch {
      /* ignore */
    }
  }
  abortRef.current?.abort();
}

const toolUpsertCtx: ToolUpsertCtx = {
  sealStreamBubble,
  findToolMsg,
  updateMsg,
  syncToolPanel,
  appendMsg,
  setDetail,
  transcriptRef,
};

async function drainQueueSoon() {
  window.setTimeout(() => {
    if (busyRef.current || stoppingRef.current) return;
    const [next, ...rest] = queuedRef.current;
    if (!next) return;
    setQueuedState(rest);
    void sendChat(next.text, {
      showUser: true,
      userDisplay: next.userDisplay,
      attachments: next.attachments,
    });
  }, 40);
}

async function sendChat(
  msg: string,
  opts?: {
    showUser?: boolean;
    userDisplay?: string;
    attachments?: MsgAttachment[];
    mode?: "plan" | "agent";
  },
) {
  if (!msg || busyRef.current) return;
  if (!activeWs?.path) {
    setToast(t("pickWorkspaceToast"));
    openSettings("workspace");
    return;
  }
  const showUser = opts?.showUser !== false;
  setInput("");
  setBusyState(true);
  stoppingRef.current = false;
  turnDoneRef.current = false;
  stickBottomRef.current = true;
  setLive([]);
  setSubs([]);
  setCompressState(null);
  setActivePlan(null);
  executingPlanIdRef.current = null;
  streamIdRef.current = null;
  streamTextRef.current = "";
  streamReasoningRef.current = "";
  nativeReasoningRef.current = false;
  thinkSplitRef.current.reset();
  if (showUser) {
    const displayText =
      opts?.userDisplay !== undefined ? opts.userDisplay : msg;
    appendMsg({
      id: uid(),
      role: "user",
      content: displayText,
      attachments: opts?.attachments,
    });
  }

  abortRef.current?.abort();
  const ac = new AbortController();
  abortRef.current = ac;

  const runMode = opts?.mode ?? chatMode;

  try {
    const displayForApi =
      opts?.userDisplay !== undefined && opts.userDisplay !== msg
        ? opts.userDisplay
        : undefined;
    const sid = await streamChat(
      msg,
      sessionId,
      {
        onEvent: (ev) =>
          handleRuntimeEvent(ev, {
            ...toolUpsertCtx,
            t,
            locale,
            sessionId,
            sessionIdRef,
            setPlanConfirm,
            setActivePlan,
            planPendingRef,
            executingPlanIdRef,
            patchSubagent,
            sealSubassistant,
            setLive,
            setSessionId,
            setCtx,
            setCompressState,
            appendStreamChunk,
            appendReasoningChunk,
            setApproval,
            findToolMsg,
            updateMsg,
            syncToolPanel,
            setDetail,
            stripDuplicateAskBubble,
            askPendingRef,
            setAskChoice,
            setAskOtherText,
            setAskPrompt,
            setFsRefresh,
            setSubs,
            appendMsg,
          }),
        onFinal: (textOut, meta) => {
          const stopped = Boolean(meta.cancelled);
          finalizeAssistant(textOut, { stopped });
          if (stopped && String(textOut || "").trim()) {
            setToast(t("stoppedKeep"));
          }
          setStats({
            tokens: Number(meta.tokens || 0),
            iters: Number(meta.iterations || 0),
          });
          if (meta.session_id) setSessionId(String(meta.session_id));
          void fetchSkills().then(setSkills);
          void fetchMemory().then(setMemory);
          void refreshSessionsRef.current();
          setFsRefresh((n) => n + 1);
        },
        onError: (err) => {
          sealStreamBubble();
          appendMsg({ id: uid(), role: "assistant", content: `错误：${err}` });
          turnDoneRef.current = true;
        },
        onAbort: () => {
          const had = streamTextRef.current.trim();
          finalizeAssistant(had, { stopped: true });
          setToast(had ? t("stoppedKeep") : t("stopped"));
        },
      },
      ac.signal,
      runMode,
      displayForApi,
    );
    if (sid) setSessionId(sid);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) {
      appendMsg({
        id: uid(),
        role: "assistant",
        content: `请求失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } finally {
    abortRef.current = null;
    stoppingRef.current = false;
    setBusyState(false);
    setApproval(null);
    if (!askPendingRef.current) {
      setAskPrompt(null);
      setAskChoice("");
      setAskOtherText("");
    }
    if (!planPendingRef.current) {
      setPlanConfirm(null);
    }
    void drainQueueSoon();
  }
}

async function attachLive(sid: string) {
  if (!sid) return;
  abortRef.current?.abort();
  const ac = new AbortController();
  abortRef.current = ac;
  stoppingRef.current = false;
  turnDoneRef.current = false;
  setBusyState(true);
  try {
    await attachSessionEvents(
      sid,
      {
        onEvent: (ev) =>
          handleRuntimeEvent(ev, {
            ...toolUpsertCtx,
            t,
            locale,
            sessionId: sid,
            sessionIdRef,
            setPlanConfirm,
            setActivePlan,
            planPendingRef,
            executingPlanIdRef,
            patchSubagent,
            sealSubassistant,
            setLive,
            setSessionId,
            setCtx,
            setCompressState,
            appendStreamChunk,
            appendReasoningChunk,
            setApproval,
            findToolMsg,
            updateMsg,
            syncToolPanel,
            setDetail,
            stripDuplicateAskBubble,
            askPendingRef,
            setAskChoice,
            setAskOtherText,
            setAskPrompt,
            setFsRefresh,
            setSubs,
            appendMsg,
          }),
        onFinal: (textOut, meta) => {
          if (meta.replay) {
            void fetchSession(sid)
              .then((d) => commit(mapSessionMessages(d.messages)))
              .catch(() => {});
            return;
          }
          const stopped = Boolean(meta.cancelled);
          finalizeAssistant(textOut, { stopped });
          setStats({
            tokens: Number(meta.tokens || 0),
            iters: Number(meta.iterations || 0),
          });
          void fetchSkills().then(setSkills);
          void fetchMemory().then(setMemory);
          void refreshSessionsRef.current();
          setFsRefresh((n) => n + 1);
        },
        onError: (err) => {
          sealStreamBubble();
          appendMsg({ id: uid(), role: "assistant", content: `错误：${err}` });
        },
        onAbort: () => {
          /* stopChat / new send replaces this attach */
        },
      },
      ac.signal,
    );
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  } finally {
    if (abortRef.current === ac) {
      abortRef.current = null;
      stoppingRef.current = false;
      setBusyState(false);
    }
  }
}

function resumeFromSnapshot(detail: SessionDetail) {
  const ap = (detail.pending_approvals || [])[0];
  if (ap?.id) {
    setApproval({
      approvalId: String(ap.id),
      callId: String(ap.id),
      name: String(ap.tool || ""),
      args: ap.args,
      summary: String(ap.summary || ap.tool || ""),
    });
  } else {
    setApproval(null);
  }
  const ask = (detail.pending_asks || [])[0];
  if (ask?.id) {
    askPendingRef.current = true;
    setAskPrompt({
      askId: String(ask.id),
      callId: String(ask.id),
      sessionId: detail.id,
      question: String(ask.question || ""),
      options: Array.isArray(ask.options) ? ask.options : [],
      allowCustom: ask.allow_custom !== false,
      customLabel: String(ask.custom_label || ""),
      summary: String(ask.question || ""),
    });
  } else {
    askPendingRef.current = false;
    setAskPrompt(null);
  }
  const plan = (detail.pending_plans || [])[0];
  if (plan?.id) {
    planPendingRef.current = true;
    setPlanConfirm({
      planId: String(plan.id),
      sessionId: detail.id,
      summary: String(plan.summary || ""),
      tasks: (plan.tasks || []).map((task, i) => ({
        id: String(task.id || `task_${i}`),
        title: String(task.title || `步骤 ${i + 1}`),
        detail: String(task.detail || ""),
        status: (task.status as "pending") || "pending",
      })),
    });
  } else {
    planPendingRef.current = false;
    setPlanConfirm(null);
  }
  if (detail.busy) void attachLive(detail.id);
}

  return {
    transcriptRef,
    streamIdRef,
    streamTextRef,
    streamReasoningRef,
    nativeReasoningRef,
    thinkSplitRef,
    abortRef,
    stoppingRef,
    turnDoneRef,
    queuedRef,
    busyRef,
    commit,
    appendMsg,
    updateMsg,
    syncToolPanel,
    findToolMsg,
    setBusyState,
    setQueuedState,
    enqueueMessage,
    removeQueued,
    clearQueued,
    updateSubagentMsg,
    patchSubagent,
    sealSubassistant,
    discardStreamBubble,
    stripDuplicateAskBubble,
    sealStreamBubble,
    ensureStreamBubble,
    syncStreamBubble,
    appendStreamChunk,
    appendReasoningChunk,
    finalizeAssistant,
    stopChat,
    upsertToolStart: (ev: RuntimeEvent) => upsertToolStart(ev, toolUpsertCtx),
    upsertToolDelta: (ev: RuntimeEvent) => upsertToolDelta(ev, toolUpsertCtx),
    upsertToolEnd: (ev: RuntimeEvent) => upsertToolEnd(ev, toolUpsertCtx),
    drainQueueSoon,
    sendChat,
    resumeFromSnapshot,
  };
}