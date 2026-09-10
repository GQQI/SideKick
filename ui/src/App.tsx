import { useEffect, useRef, useState } from "react";
import {
  authLogin,
  authLogout,
  authSetup,
  fetchShellJobs,
  fetchSkills,
  type Health,
  type SessionItem,
  type ShellJobSnapshot,
  type SkillItem,
  type WorkspaceItem,
} from "./api";
import {
  loadExplorerCollapsed,
  loadExplorerWidth,
  loadSidePanel,
} from "./layoutPersist";
import { saveActiveSessionId } from "./sessionPersist";
import { loadOpenTabs, saveOpenTabs, type ChatTabRef } from "./chatTabsPersist";
import { usePrefs } from "./prefs";
import type { ModelSetup, ModelRole } from "./types/modelSetup";
import {
  type ApprovalPrompt,
  type AskPrompt,
  type ChatMsg,
  type DetailView,
  type LiveLine,
  type PendingConfirm,
  type QueuedMsg,
  type SettingsTab,
  type SubNode,
} from "./types/chat";
import type { ActivePlan, PlanConfirmState } from "./types/plan";
import {
  chipLabelForDom,
  formatDomElementForAgent,
} from "./browser/protocol";
import { sanitizeBrowserUrl } from "./browser/urlDetect";
import { fileToDetail, uid } from "./utils/chatHelpers";
import type { FileDiffPreview } from "./utils/diffPreview";
import { ActivitySidebar } from "./components/ActivitySidebar";
import { AppHeader } from "./components/AppHeader";
import type { BrowserOpenRequest } from "./components/BrowserPanel";
import { ChatThread } from "./components/ChatThread";
import { ChatTabsBar, type ChatTabView } from "./components/ChatTabsBar";
import { ComposerBar } from "./components/ComposerBar";
import { ConfirmBanner } from "./components/ConfirmBanner";
import { DetailPanel } from "./components/DetailPanel";
import { EditRestoreModal } from "./components/EditRestoreModal";
import { MemoryLibraryPanel } from "./components/MemoryLibrary";
import { SandboxUrlPrompt, type SandboxUrlPromptState } from "./components/SandboxUrlPrompt";
import { SettingsModal } from "./components/SettingsModal";
import { AuthGate } from "./components/AuthGate";
import { WelcomeGate } from "./components/WelcomeGate";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap";
import { useChatStream } from "./hooks/useChatStream";
import { useMessageActions } from "./hooks/useMessageActions";
import { useDialogs } from "./hooks/useDialogs";
import { useAuthBoot } from "./hooks/useAuthBoot";
import { useAppChrome } from "./hooks/useAppChrome";
import { useComposerMenus } from "./hooks/useComposerMenus";
import { useToolDiffs } from "./hooks/useToolDiffs";

export function App() {
  const { t, locale, theme, density, setLocale, setTheme, setDensity } = usePrefs();
  const [health, setHealth] = useState<Health | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<
    { id: string; name: string; path: string; kind: string; text?: string; size?: number }[]
  >([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveLine[]>([]);
  const [subs, setSubs] = useState<SubNode[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [memory, setMemory] = useState("");
  const [model, setModel] = useState<ModelSetup | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSwitchRole, setModelSwitchRole] = useState<ModelRole>("main");
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [activeWs, setActiveWs] = useState<{ path: string; name: string; id?: string } | null>(
    null,
  );
  const [wsBusy, setWsBusy] = useState(false);
  const [bootReady, setBootReady] = useState(false);
  const [authPhase, setAuthPhase] = useState<"loading" | "setup" | "login" | "ok">("loading");
  const [authBusy, setAuthBusy] = useState(false);
  const [accountUser, setAccountUser] = useState<{
    id: string;
    username: string;
    email?: string;
  } | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [openTabs, setOpenTabs] = useState<ChatTabRef[]>(() => loadOpenTabs());
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsTotalPages, setSessionsTotalPages] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("workspace");
  const [mainView, setMainView] = useState<"chat" | "memory">("chat");
  const [stats, setStats] = useState({ tokens: 0, iters: 0 });
  const [ctx, setCtx] = useState({ tokens: 0, limit: 48000 });
  const [compressState, setCompressState] = useState<{
    active: boolean;
    message: string;
    attempt: number;
    maxAttempts: number;
    before: number;
    after?: number;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [explorerCollapsed, setExplorerCollapsed] = useState(loadExplorerCollapsed);
  const [sidePanel, setSidePanel] = useState(loadSidePanel);
  const [sandboxUrlPrompt, setSandboxUrlPrompt] = useState<SandboxUrlPromptState | null>(null);
  const [browserOpenRequest, setBrowserOpenRequest] = useState<BrowserOpenRequest | null>(null);
  const lastBrowserOpenRef = useRef<{ url: string; at: number } | null>(null);
  const [shellJobs, setShellJobs] = useState<ShellJobSnapshot[]>([]);
  const [jobsTick, setJobsTick] = useState(0);
  const [jobsFocusId, setJobsFocusId] = useState("");
  const jobStatusRef = useRef<Record<string, string>>({});
  const [explorerWidth, setExplorerWidth] = useState(() => loadExplorerWidth(280));
  const [detailWidth, setDetailWidth] = useState(420);
  const [fsRefresh, setFsRefresh] = useState(0);
  const [detail, setDetail] = useState<DetailView>(null);
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null);
  const [approvalDiff, setApprovalDiff] = useState<FileDiffPreview | null>(null);
  const [approvalDiffLoading, setApprovalDiffLoading] = useState(false);
  const [detailDiff, setDetailDiff] = useState<FileDiffPreview | null>(null);
  const [detailDiffLoading, setDetailDiffLoading] = useState(false);
  const [askPrompt, setAskPrompt] = useState<AskPrompt | null>(null);
  const [askChoice, setAskChoice] = useState("");
  const [askOtherText, setAskOtherText] = useState("");
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [chatMode, setChatMode] = useState<"plan" | "agent">("agent");
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null);
  const [planConfirm, setPlanConfirm] = useState<PlanConfirmState | null>(null);
  const [planConfirmSubmitting, setPlanConfirmSubmitting] = useState(false);
  const [queued, setQueued] = useState<QueuedMsg[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editRestorePrompt, setEditRestorePrompt] = useState<{
    msgId: string;
    text: string;
    keepUserTurns: number;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickBottomRef = useRef(true);
  const resizingRef = useRef(false);
  const resizingDetailRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const askPendingRef = useRef(false);
  const planPendingRef = useRef(false);
  const executingPlanIdRef = useRef<string | null>(null);
  const refreshSessionsRef = useRef<(page?: number) => Promise<void>>(async () => {});
  const openSettingsRef = useRef<(tab?: SettingsTab) => void>(() => {});
  const newChatRef = useRef<() => Promise<void>>(async () => {});

  const chat = useChatStream({
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
  });

  const session = useSessionBootstrap({
    sessionsPage,
    activeWsPath: activeWs?.path || null,
    activeWorkspaceId: activeWs?.id || null,
    setHealth,
    setWorkspaces,
    setActiveWs,
    setBootReady,
    setSessionId,
    setSkills,
    setMemory,
    setModel,
    setSessions,
    setSessionsPage,
    setSessionsTotal,
    setSessionsTotalPages,
    setCtx,
    setLive,
    setSubs,
    commit: chat.commit,
    streamIdRef: chat.streamIdRef,
    streamTextRef: chat.streamTextRef,
    streamReasoningRef: chat.streamReasoningRef,
    nativeReasoningRef: chat.nativeReasoningRef,
    setSidePanel,
    setExplorerCollapsed,
    onResumeRuntime: chat.resumeFromSnapshot,
  });

  refreshSessionsRef.current = session.refreshSessions;

  const dialogs = useDialogs({
    t,
    sessionId,
    sessionIdRef,
    approval,
    askPrompt,
    askSubmitting,
    planConfirm,
    planConfirmSubmitting,
    model,
    detail,
    setSettingsTab,
    setSettingsOpen,
    setModel,
    setModelSaving,
    setHealth,
    setToast,
    setApproval,
    setAskPrompt,
    setAskChoice,
    setAskOtherText,
    setAskSubmitting,
    askPendingRef,
    setPlanConfirm,
    setPlanConfirmSubmitting,
    planPendingRef,
    executingPlanIdRef,
    setActivePlan,
    setDetail,
    setPendingConfirm,
    setFsRefresh,
    onNewChat: () => newChatRef.current(),
  });

  openSettingsRef.current = dialogs.openSettings;

  const actions = useMessageActions({
    t,
    locale,
    input,
    setInput,
    attachments,
    setAttachments,
    attachBusy,
    setAttachBusy,
    attachInputRef,
    composerRef,
    busy,
    sessionId,
    sessionIdRef,
    sessionsPage,
    skills,
    setSkills,
    memory,
    setMemory,
    model,
    health,
    stats,
    ctx,
    activeWs,
    setActiveWs,
    setWorkspaces,
    setHealth,
    setModel,
    setWsBusy,
    setFsRefresh,
    setToast,
    setSessionId,
    setSessions,
    setSessionsPage,
    setSessionsTotal,
    setSessionsTotalPages,
    setSidePanel,
    setExplorerCollapsed,
    setDetail,
    setLive,
    setSubs,
    setApproval,
    setAskPrompt,
    setAskChoice,
    setAskOtherText,
    setActivePlan,
    setEditingId,
    setEditDraft,
    setEditRestorePrompt,
    editDraft,
    editRestorePrompt,
    setCopiedId,
    openSettings: (tab) => openSettingsRef.current(tab),
    openMemory: () => {
      setMainView("memory");
      setExplorerCollapsed(true);
      setSettingsOpen(false);
    },
    openChat: () => setMainView("chat"),
    openHistoryPanel: session.openHistoryPanel,
    refreshSessions: session.refreshSessions,
    applySessionDetail: session.applySessionDetail,
    resetContextUsage: session.resetContextUsage,
    commit: chat.commit,
    appendMsg: chat.appendMsg,
    transcriptRef: chat.transcriptRef,
    busyRef: chat.busyRef,
    streamIdRef: chat.streamIdRef,
    streamTextRef: chat.streamTextRef,
    streamReasoningRef: chat.streamReasoningRef,
    nativeReasoningRef: chat.nativeReasoningRef,
    enqueueMessage: chat.enqueueMessage,
    clearQueued: chat.clearQueued,
    queuedCount: queued.length,
    sendChat: chat.sendChat,
    stopChat: chat.stopChat,
    detachListener: chat.detachListener,
    setBusy,
  });

  newChatRef.current = actions.newChat;

  const historySessions = sessions.map((s) => ({
    ...s,
    busy:
      chat.runningSessionIds.includes(s.id) ||
      Boolean(busy && s.id === sessionId),
  }));

  // Identify a workspace by its stable id when we have one; only fall back
  // to the raw path string for tabs persisted before this field existed.
  // Every "which tab belongs to which project" comparison in this file goes
  // through these two so id vs. path can never disagree with itself.
  function workspaceKey(ws: { id?: string; path?: string } | null | undefined): string {
    return ws?.id || ws?.path || "";
  }
  function tabWorkspaceKey(tab: ChatTabRef): string {
    return tab.workspaceId || tab.workspace || "";
  }

  /**
   * Switch the active chat to `path` — reuse an already-open tab for that
   * workspace if one exists, otherwise start a fresh chat pinned there.
   * Every side panel (search/files/browser/git/jobs/undo/history) reads
   * `activeWs`, so they all follow this switch automatically.
   */
  function switchToWorkspace(path: string) {
    if (!path || path === activeWs?.path) return;
    const targetId = workspaces.find((w) => w.path === path)?.id;
    const key = targetId || path;
    const existing = openTabs.find((t) => tabWorkspaceKey(t) === key);
    if (existing) {
      selectChatTab(existing.id);
    } else {
      void actions.newChatInWorkspace(path);
    }
  }

  function selectChatTab(id: string) {
    // Restore the tab's workspace immediately so the file explorer does not
    // keep showing the previous chat's folder while fetchSession is in flight.
    const tab = openTabs.find((t) => t.id === id);
    if (tab?.workspace) {
      setActiveWs({
        path: tab.workspace,
        name: tab.workspaceName || tab.workspace.split(/[/\\]/).pop() || tab.workspace,
        id: tab.workspaceId,
      });
    }
    void actions.openSession(id);
  }

  function closeTab(id: string) {
    const closing = openTabs.find((t) => t.id === id);
    setOpenTabs((prev) => prev.filter((t) => t.id !== id));
    if (id !== sessionId) return;
    const remaining = openTabs.filter((t) => t.id !== id);
    // Closing the active tab must never jump to a DIFFERENT project's tab —
    // that's what caused the "closes B, lands on A" bounce. Stay inside the
    // same workspace (matched by id, not a raw path-string guess): reuse
    // another of its tabs, or open a fresh draft there.
    const key = closing ? tabWorkspaceKey(closing) : workspaceKey(activeWs);
    const sameWs = key ? remaining.find((t) => tabWorkspaceKey(t) === key) : undefined;
    const ws = closing?.workspace || activeWs?.path || "";
    if (sameWs) {
      selectChatTab(sameWs.id);
    } else if (ws) {
      void actions.newChatInWorkspace(ws);
    } else if (remaining.length) {
      selectChatTab(remaining[0].id);
    } else {
      void actions.newChat();
    }
  }

  /**
   * Remove a workspace from the recent list AND close any chat tabs still
   * pinned to it, so it fully disappears everywhere (settings, hub row,
   * chat tab strip) — not just from the "recent folders" list.
   */
  function forgetWorkspaceEverywhere(path: string) {
    const targetId = workspaces.find((w) => w.path === path)?.id;
    const key = targetId || path;
    const closing = openTabs.filter((t) => tabWorkspaceKey(t) === key);
    if (closing.length) {
      const closingIds = new Set(closing.map((t) => t.id));
      setOpenTabs((prev) => prev.filter((t) => !closingIds.has(t.id)));
      if (sessionId && closingIds.has(sessionId)) {
        const remaining = openTabs.filter((t) => !closingIds.has(t.id));
        if (remaining.length) selectChatTab(remaining[0].id);
        else void actions.newChat();
      }
    }
    void actions.removeWorkspaceEntry(path);
  }

  // Auto-surface any session that is actually running server-side, even if
  // the user never explicitly "opened" it as a tab (e.g. it kept going in
  // the background while they were looking at a different workspace).
  useEffect(() => {
    const runningIds = new Set(chat.runningSessionIds);
    if (sessionId) runningIds.add(sessionId);
    if (runningIds.size === 0) return;
    setOpenTabs((prev) => {
      const known = new Set(prev.map((t) => t.id));
      const additions: ChatTabRef[] = [];
      for (const id of runningIds) {
        if (known.has(id)) continue;
        const hit = historySessions.find((s) => s.id === id);
        additions.push({
          id,
          workspace: hit?.workspace || (id === sessionId ? activeWs?.path || "" : ""),
          workspaceId: hit?.workspace_id || (id === sessionId ? activeWs?.id : undefined),
          workspaceName: hit?.workspace_name || (id === sessionId ? activeWs?.name || "" : ""),
        });
      }
      if (!additions.length) return prev;
      return [...prev, ...additions].slice(0, 16);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.runningSessionIds, sessionId]);

  useEffect(() => {
    saveOpenTabs(openTabs);
  }, [openTabs]);

  // Keep the active tab's workspace stamp in sync with the session we just
  // loaded (or the hub pick), so switching away and back restores the right folder.
  useEffect(() => {
    if (!sessionId || !activeWs?.path) return;
    setOpenTabs((prev) => {
      const hit = prev.find((t) => t.id === sessionId);
      if (
        hit &&
        hit.workspace === activeWs.path &&
        hit.workspaceId === activeWs.id &&
        hit.workspaceName === (activeWs.name || hit.workspaceName)
      ) {
        return prev;
      }
      if (hit) {
        return prev.map((t) =>
          t.id === sessionId
            ? {
                ...t,
                workspace: activeWs.path,
                workspaceId: activeWs.id,
                workspaceName: activeWs.name || t.workspaceName,
              }
            : t,
        );
      }
      return [
        ...prev,
        {
          id: sessionId,
          workspace: activeWs.path,
          workspaceId: activeWs.id,
          workspaceName: activeWs.name || "",
        },
      ].slice(0, 16);
    });
  }, [sessionId, activeWs?.path, activeWs?.id, activeWs?.name]);

  // The tab strip above the composer is scoped to the workspace on screen —
  // other workspaces' chats stay open in the background (openTabs keeps them)
  // but only surface again once you switch back to that workspace.
  const activeWsKey = workspaceKey(activeWs);
  const chatTabViews: ChatTabView[] = openTabs
    .filter((tab) => !activeWsKey || !tabWorkspaceKey(tab) || tabWorkspaceKey(tab) === activeWsKey)
    .map((tab) => {
      const hit = historySessions.find((s) => s.id === tab.id);
      const running =
        chat.runningSessionIds.includes(tab.id) || Boolean(busy && tab.id === sessionId);
      const rawTitle = (hit?.title || "").trim();
      const untitled = !rawTitle || rawTitle === "新会话" || rawTitle === "New chat" || rawTitle === "Untitled";
      return {
        id: tab.id,
        title: untitled ? t("sessionUntitled") : rawTitle,
        workspaceName: hit?.workspace_name || tab.workspaceName || tab.workspace || "",
        running,
        active: tab.id === sessionId,
      };
    });

  const openTabWorkspaces = openTabs
    .filter((tab) => tab.workspace)
    .map((tab) => ({
      path: tab.workspace,
      name: tab.workspaceName || tab.workspace,
      running: chat.runningSessionIds.includes(tab.id) || Boolean(busy && tab.id === sessionId),
    }));

  const historyNeedsPoll =
    busy || chat.runningSessionIds.length > 0 || openTabs.length > 1;

  const reconcileRunningRef = useRef(chat.reconcileRunningSessions);
  reconcileRunningRef.current = chat.reconcileRunningSessions;

  useEffect(() => {
    reconcileRunningRef.current(sessions);
  }, [sessions, chat.runningSessionIds]);

  useEffect(() => {
    if (!historyNeedsPoll) return;
    const timer = window.setInterval(() => {
      void session.refreshSessions();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [historyNeedsPoll, session.refreshSessions]);

  const { finishAuth } = useAuthBoot({
    boot: session.boot,
    setHealth,
    setBootReady,
    setAuthPhase,
    setAccountUser,
  });

  useAppChrome({
    sidePanel,
    explorerCollapsed,
    explorerWidth,
    setExplorerCollapsed,
    setExplorerWidth,
    setDetailWidth,
    resizingRef,
    resizingDetailRef,
    stickBottomRef,
    threadRef,
    bottomRef,
    composerRef,
    messages,
    busy,
    compressState,
    bootReady,
    contextLimit: health?.context_limit,
    hasSession: Boolean(sessionId),
    setCtx,
    toast,
    setToast,
    approval,
    askPrompt,
    planConfirm,
    settingsOpen,
    setSettingsOpen,
    detail,
    setDetail,
    input,
    setInput,
    sessionsPage,
    onNewChat: () => void actions.newChat(),
    onOpenHistory: session.openHistoryPanel,
    onOpenSettings: dialogs.openSettings,
  });

  const composerMenus = useComposerMenus(input, skills, locale, activeWs?.path);
  useToolDiffs(
    approval,
    detail,
    setApprovalDiff,
    setApprovalDiffLoading,
    setDetailDiff,
    setDetailDiffLoading,
  );

  useEffect(() => {
    if (sessionId) saveActiveSessionId(sessionId, activeWs?.path || null);
  }, [sessionId, activeWs?.path]);

  // History (and the chat-tabs strip, filtered below) is scoped to the
  // workspace on screen — switching workspace must switch which history shows.
  useEffect(() => {
    if (!bootReady) return;
    void session.refreshSessions(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady, activeWs?.id, activeWs?.path]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const url = String((ev as CustomEvent<{ url?: string }>).detail?.url || "");
      setSidePanel("browser");
      setExplorerCollapsed(false);
      setExplorerWidth((w) => (w < 520 ? 640 : w));
      if (!url) return;
      const last = lastBrowserOpenRef.current;
      if (last && last.url === url && Date.now() - last.at < 1600) return;
      lastBrowserOpenRef.current = { url, at: Date.now() };
      setBrowserOpenRequest({ url, nonce: Date.now() });
    };
    window.addEventListener("sidekick-browser-open", onOpen);
    return () => window.removeEventListener("sidekick-browser-open", onOpen);
  }, []);

  useEffect(() => {
    const onJob = (ev: Event) => {
      const d = (ev as CustomEvent<{ job_id?: string }>).detail || {};
      if (d.job_id) setJobsFocusId(String(d.job_id));
      setJobsTick((n) => n + 1);
    };
    window.addEventListener("sidekick-shell-job", onJob);
    return () => window.removeEventListener("sidekick-shell-job", onJob);
  }, []);

  useEffect(() => {
    if (!bootReady || authPhase !== "ok") return;
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetchShellJobs(true);
        if (!cancelled) setShellJobs(res.jobs || []);
      } catch {
        /* ignore */
      }
    };
    void pull();
    const timer = window.setInterval(pull, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bootReady, authPhase, jobsTick]);

  useEffect(() => {
    const prev = jobStatusRef.current;
    const next: Record<string, string> = { ...prev };
    for (const job of shellJobs) {
      const was = prev[job.job_id];
      next[job.job_id] = job.status;
      if (was !== "running" || job.status === "running") continue;
      if (job.session_id && sessionId && job.session_id !== sessionId) continue;
      const title =
        job.status === "killed"
          ? t("jobsDoneKilled")
          : job.exit_code && job.exit_code !== 0
            ? t("jobsDoneFail")
            : t("jobsDoneOk");
      const lines = [
        title,
        "",
        `- 命令：\`${job.command}\``,
        `- 状态：${job.status}${job.exit_code != null ? `（exit ${job.exit_code}）` : ""}`,
        `- 用时：${job.elapsed_sec}s`,
        `- job_id：${job.job_id}`,
      ];
      if (job.log?.trim()) {
        lines.push("", "```", job.log.trim(), "```");
      }
      chat.appendMsg({
        id: `job-done-${job.job_id}`,
        role: "assistant",
        content: lines.join("\n"),
        jobNotice: {
          job_id: job.job_id,
          status: job.status,
          exit_code: job.exit_code,
        },
      });
      setToast(t("jobsDoneToast", job.command));
    }
    jobStatusRef.current = next;
  }, [shellJobs, sessionId, t, chat]);

  function openJobsPanel(jobId?: string) {
    if (jobId) setJobsFocusId(jobId);
    setSidePanel("jobs");
    setExplorerCollapsed(false);
    setExplorerWidth((w) => (w < 420 ? 480 : w));
  }

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottomRef.current = dist < 80;
  }

  function openDetail(d: DetailView) {
    stickBottomRef.current = false;
    setDetail(d);
  }

  const ctxPct = Math.min(100, Math.round((ctx.tokens / Math.max(1, ctx.limit)) * 100));
  const ctxWarn = ctxPct >= 72;
  const needsWorkspace = bootReady && authPhase === "ok" && !activeWs?.path;

  return (
    <div className="shell">
      <div className="wash" aria-hidden />
      <AppHeader
        t={t}
        theme={theme}
        hasWorkspace={Boolean(activeWs?.path)}
        onOpenHistory={session.openHistoryPanel}
        onNewChat={() => void actions.newChat()}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />

      <SandboxUrlPrompt
        prompt={sandboxUrlPrompt}
        onCancel={() => setSandboxUrlPrompt(null)}
        onConfirm={() => {
          if (!sandboxUrlPrompt) return;
          const target = sanitizeBrowserUrl(sandboxUrlPrompt.url) || sandboxUrlPrompt.url;
          setSandboxUrlPrompt(null);
          setBrowserOpenRequest({ url: target, nonce: Date.now() });
          setSidePanel("browser");
          setExplorerCollapsed(false);
          setExplorerWidth((w) => (w < 520 ? 640 : w));
          setToast(t("browserOpenConfirm"));
        }}
      />
      {toast && (
        <div className="toast" onClick={() => setToast("")}>
          {toast}
        </div>
      )}
      {pendingConfirm && (
        <ConfirmBanner
          pending={pendingConfirm}
          onCancel={() => setPendingConfirm(null)}
          onError={setToast}
        />
      )}

      <main className="workbench">
        {!bootReady || authPhase === "loading" ? (
          <section className="welcome-gate boot-gate" aria-busy="true" aria-label="Loading">
            <div className="boot-spinner" />
          </section>
        ) : authPhase === "setup" || authPhase === "login" ? (
          <AuthGate
            mode={authPhase}
            busy={authBusy}
            onSetup={async (payload) => {
              setAuthBusy(true);
              try {
                await authSetup(payload);
                await finishAuth();
              } finally {
                setAuthBusy(false);
              }
            }}
            onLogin={async (payload) => {
              setAuthBusy(true);
              try {
                await authLogin(payload);
                await finishAuth();
              } finally {
                setAuthBusy(false);
              }
            }}
          />
        ) : needsWorkspace ? (
          <WelcomeGate
            title={t("welcomeTitle")}
            hint={t("welcomeHint")}
            openLabel={t("openFolder")}
            browsingLabel={t("browsing")}
            recentLabel={t("recentFolders")}
            busy={wsBusy}
            workspaces={workspaces}
            onBrowse={() => void actions.browseAndSetWorkspace()}
            onSelect={(path) => void actions.switchWorkspace(path)}
          />
        ) : (
          <>
            <ActivitySidebar
              t={t}
              sidePanel={sidePanel}
              setSidePanel={setSidePanel}
              explorerCollapsed={explorerCollapsed}
              setExplorerCollapsed={setExplorerCollapsed}
              explorerWidth={explorerWidth}
              fsRefresh={fsRefresh}
              activeWs={activeWs}
              workspaces={workspaces}
              openTabWorkspaces={openTabWorkspaces}
              sessions={historySessions}
              sessionId={sessionId}
              sessionsPage={sessionsPage}
              sessionsTotalPages={sessionsTotalPages}
              sessionsTotal={sessionsTotal}
              onOpenHistoryPanel={session.openHistoryPanel}
              onRefreshSessions={session.refreshSessions}
              onOpenSession={(id) => {
                const hit = historySessions.find((s) => s.id === id);
                if (hit?.workspace) {
                  setActiveWs({
                    path: hit.workspace,
                    name:
                      hit.workspace_name ||
                      hit.workspace.split(/[/\\]/).pop() ||
                      hit.workspace,
                  });
                }
                void actions.openSession(id);
              }}
              onNewChat={actions.newChat}
              onSwitchWorkspace={switchToWorkspace}
              onForgetWorkspace={forgetWorkspaceEverywhere}
              onDeleteSession={actions.removeSession}
              onOpenSettings={() => dialogs.openSettings()}
              onOpenFile={(file, opts) => openDetail(fileToDetail(file, opts))}
              activeFilePath={detail?.type === "file" ? detail.path : null}
              onFileDeleted={(path) => {
                setDetail((d) => {
                  if (d?.type !== "file") return d;
                  if (d.path === path || d.path.startsWith(`${path}/`)) return null;
                  return d;
                });
                setFsRefresh((n) => n + 1);
              }}
              onResizeStart={() => {
                resizingRef.current = true;
                document.body.classList.add("resizing-sidebar");
              }}
              onPickDomElement={(el) => {
                setAttachments((prev) => [
                  ...prev,
                  {
                    id: uid(),
                    name: chipLabelForDom(el),
                    path: el.xpath || el.css_path || el.url || "dom",
                    kind: "dom-element",
                    text: formatDomElementForAgent(el),
                  },
                ]);
                setToast(t("browserElementAdded"));
              }}
              browserOpenRequest={browserOpenRequest}
              browserSuspended={settingsOpen || Boolean(sandboxUrlPrompt) || Boolean(editRestorePrompt)}
              onWorkspaceMutated={() => setFsRefresh((n) => n + 1)}
              mainView={mainView}
              onOpenMemory={() => {
                setMainView("memory");
                setExplorerCollapsed(true);
                setSettingsOpen(false);
              }}
              onOpenChat={() => setMainView("chat")}
              jobsRunning={shellJobs.filter((j) => j.status === "running").length}
              jobsFocusId={jobsFocusId}
              jobsRefreshKey={jobsTick}
            />
            {mainView === "memory" ? (
              <MemoryLibraryPanel
                t={t}
                onToast={setToast}
                onBack={() => setMainView("chat")}
              />
            ) : (
              <>
                <section className="chat pane">
                  <ChatTabsBar
                    t={t}
                    tabs={chatTabViews}
                    onSelect={selectChatTab}
                    onClose={closeTab}
                    onNewTab={() => void actions.newChat()}
                  />
                  <ChatThread
                    t={t}
                    messages={messages}
                    busy={busy}
                    stopping={chat.stoppingRef.current}
                    queuedCount={queued.length}
                    compressState={compressState}
                    detail={detail}
                    editingId={editingId}
                    editDraft={editDraft}
                    copiedId={copiedId}
                    threadRef={threadRef}
                    bottomRef={bottomRef}
                    onThreadScroll={onThreadScroll}
                    onSetDetail={openDetail}
                    onSend={actions.send}
                    onStopChat={chat.stopChat}
                    onCopyBubble={actions.copyBubble}
                    onStartEditUser={actions.startEditUser}
                    onEditDraftChange={setEditDraft}
                    onCancelEdit={actions.cancelEdit}
                    onRequestSubmitEdit={actions.requestSubmitEdit}
                    onCtrlClickUrl={(url, x, y) =>
                      setSandboxUrlPrompt({ url: sanitizeBrowserUrl(url) || url, x, y })
                    }
                    onToast={setToast}
                    askPrompt={askPrompt}
                    askChoice={askChoice}
                    askOtherText={askOtherText}
                    askSubmitting={askSubmitting}
                    onResolveAsk={dialogs.resolveAsk}
                    onAskChoice={setAskChoice}
                    onAskOtherText={setAskOtherText}
                    runningJobs={shellJobs.filter((j) => j.status === "running")}
                    onOpenJobs={openJobsPanel}
                  />
                  <ComposerBar
                    t={t}
                    locale={locale}
                    input={input}
                    setInput={setInput}
                    attachments={attachments}
                    setAttachments={setAttachments}
                    attachBusy={attachBusy}
                    attachInputRef={attachInputRef}
                    composerRef={composerRef}
                    busy={busy}
                    chatMode={chatMode}
                    setChatMode={setChatMode}
                    slashOpen={composerMenus.slashOpen}
                    slashItems={composerMenus.slashItems}
                    slashIndex={composerMenus.slashIndex}
                    setSlashIndex={composerMenus.setSlashIndex}
                    atFileOpen={composerMenus.atFileOpen}
                    atFileHits={composerMenus.atFileHits}
                    atFileIndex={composerMenus.atFileIndex}
                    setAtFileIndex={composerMenus.setAtFileIndex}
                    atFileLoading={composerMenus.atFileLoading}
                    queued={queued}
                    activePlan={activePlan}
                    planConfirm={planConfirm}
                    planConfirmSubmitting={planConfirmSubmitting}
                    approval={approval}
                    approvalDiff={approvalDiff}
                    approvalDiffLoading={approvalDiffLoading}
                    ctxPct={ctxPct}
                    ctxWarn={ctxWarn}
                    ctx={ctx}
                    model={model}
                    modelSwitchRole={modelSwitchRole}
                    setModelSwitchRole={setModelSwitchRole}
                    modelSaving={modelSaving}
                    onSend={actions.send}
                    onStopChat={chat.stopChat}
                    onApplySlashItem={actions.applySlashItem}
                    onApplyAtFile={actions.applyAtFile}
                    onAddAttachments={actions.addAttachments}
                    onClearQueued={chat.clearQueued}
                    onRemoveQueued={chat.removeQueued}
                    onResolvePlanConfirm={dialogs.resolvePlanConfirm}
                    onResolveApproval={dialogs.resolveApproval}
                    onOpenSettings={dialogs.openSettings}
                    onSwitchModelRole={dialogs.switchModelRole}
                    gitRefreshKey={fsRefresh}
                    sessionId={sessionId}
                    workspace={activeWs?.path || null}
                    onOpenReview={() => openDetail({ type: "changes", selectedPath: null })}
                  />
                </section>
                {detail && (
                  <DetailPanel
                    t={t}
                    locale={locale}
                    detail={detail}
                    detailWidth={detailWidth}
                    detailDiff={detailDiff}
                    detailDiffLoading={detailDiffLoading}
                    fsRefresh={fsRefresh}
                    sessionId={sessionId}
                    workspace={activeWs?.path || null}
                    onResizeStart={() => {
                      resizingDetailRef.current = true;
                      document.body.classList.add("resizing-sidebar");
                    }}
                    onClose={() => setDetail(null)}
                    onChange={setDetail}
                    onSaveFile={() => void dialogs.saveDetailFile()}
                    onPickUrl={(pick) => setSandboxUrlPrompt(pick)}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      {editRestorePrompt && (
        <EditRestoreModal
          t={t}
          onClose={() => setEditRestorePrompt(null)}
          onChatOnly={() => void actions.submitEdit(editRestorePrompt.msgId, false)}
          onWithFiles={() => void actions.submitEdit(editRestorePrompt.msgId, true)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          t={t}
          locale={locale}
          theme={theme}
          density={density}
          setTheme={setTheme}
          setLocale={setLocale}
          setDensity={setDensity}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
          activeWs={activeWs}
          workspaces={workspaces}
          wsBusy={wsBusy}
          onBrowseWorkspace={actions.browseAndSetWorkspace}
          onSwitchWorkspace={actions.switchWorkspace}
          onForgetWorkspace={forgetWorkspaceEverywhere}
          sessions={historySessions}
          model={model}
          modelSaving={modelSaving}
          onModelChange={setModel}
          onModelSave={dialogs.applyModel}
          subs={subs}
          live={live}
          accountUser={accountUser}
          onToast={(msg) => setToast(msg)}
          onSkillsChanged={() => {
            void fetchSkills().then(setSkills).catch(() => undefined);
          }}
          onLogout={async () => {
            await authLogout();
            setAccountUser(null);
            setAuthPhase("login");
            setSessionId(null);
            setMessages([]);
            setActiveWs(null);
          }}
        />
      )}
    </div>
  );
}
