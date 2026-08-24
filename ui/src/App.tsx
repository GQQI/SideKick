import { useEffect, useMemo, useRef, useState } from "react";
import {
  authLogin,
  authLogout,
  authSetup,
  ensureApiToken,
  fetchAuthStatus,
  fetchHealth,
  fetchMemory,
  fetchSessions,
  getStoredToken,
  listFiles,
  searchFiles,
  type Health,
  type SessionItem,
  type SkillItem,
  type WorkspaceItem,
} from "./api";
import { FileHighlightView, FileTextEditor, countTextLines } from "./components/FileHighlightView";
import { IconRobotCube } from "./components/IconRobotCube";
import {
  IconClock,
  IconMoon,
  IconPlus,
  IconSun,
  IconX,
} from "./components/icons";
import {
  loadExplorerCollapsed,
  loadExplorerWidth,
  loadSidePanel,
  saveExplorerCollapsed,
  saveExplorerWidth,
  saveSidePanel,
} from "./layoutPersist";
import { saveActiveSessionId } from "./sessionPersist";
import { usePrefs } from "./prefs";
import { atFileMenuQuery } from "./components/AtFileMenu";
import { DiffReview } from "./components/DiffReview";
import {
  buildFileDiff,
  isFileMutatingTool,
  toolDiffKey,
  type FileDiffPreview,
} from "./utils/diffPreview";
import { WelcomeGate } from "./components/WelcomeGate";
import { AuthGate } from "./components/AuthGate";
import { MarkdownView } from "./components/MarkdownView";
import { ThinkingBlock } from "./components/ThinkingBlock";
import {
  buildSlashMenuItems,
  slashMenuQuery,
} from "./slash/commands";
import type { ModelSetup, ModelRole } from "./types/modelSetup";
import { modelLabel } from "./types/modelSetup";
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
import {
  fileToDetail,
  formatArgs,
  formatBytes,
  uid,
  writeFilePreview,
} from "./utils/chatHelpers";
import { ActivitySidebar } from "./components/ActivitySidebar";
import type { BrowserOpenRequest } from "./components/BrowserPanel";
import { ChatThread } from "./components/ChatThread";
import { ComposerBar } from "./components/ComposerBar";
import { ReviewPanel } from "./components/ChangesBar";
import { MemoryLibraryPanel } from "./components/MemoryLibrary";
import { LinkifiedText } from "./components/LinkifiedText";
import { SandboxUrlPrompt, type SandboxUrlPromptState } from "./components/SandboxUrlPrompt";
import { SettingsModal } from "./components/SettingsModal";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap";
import { useChatStream } from "./hooks/useChatStream";
import { useMessageActions } from "./hooks/useMessageActions";
import { useDialogs } from "./hooks/useDialogs";

export function App() {
  const { t, locale, theme, density, setLocale, setTheme, setDensity } = usePrefs();
  const [health, setHealth] = useState<Health | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<
    {
      id: string;
      name: string;
      path: string;
      kind: string;
      text?: string;
      size?: number;
    }[]
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
  const [activeWs, setActiveWs] = useState<{ path: string; name: string } | null>(null);
  const [wsBusy, setWsBusy] = useState(false);
  /** False until health + workspace state are known — avoids welcome flash on refresh. */
  const [bootReady, setBootReady] = useState(false);
  const [authPhase, setAuthPhase] = useState<"loading" | "setup" | "login" | "ok">("loading");
  const [authBusy, setAuthBusy] = useState(false);
  const [accountUser, setAccountUser] = useState<{
    id: string;
    username: string;
    email?: string;
  } | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
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
  const [askChoice, setAskChoice] = useState<string>("");
  const [askOtherText, setAskOtherText] = useState("");
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [chatMode, setChatMode] = useState<"plan" | "agent">("agent");
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null);
  const [planConfirm, setPlanConfirm] = useState<PlanConfirmState | null>(null);
  const [planConfirmSubmitting, setPlanConfirmSubmitting] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [atFileHits, setAtFileHits] = useState<
    { path: string; name: string; kind?: string; match?: string }[]
  >([]);
  const [atFileIndex, setAtFileIndex] = useState(0);
  const [atFileLoading, setAtFileLoading] = useState(false);
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
    sendChat: chat.sendChat,
    stopChat: chat.stopChat,
  });

  newChatRef.current = actions.newChat;

  useEffect(() => {
    saveSidePanel(sidePanel);
  }, [sidePanel]);

  useEffect(() => {
    if (sidePanel === "browser" && !explorerCollapsed) {
      setExplorerWidth((w) => (w < 520 ? 640 : w));
    }
  }, [sidePanel, explorerCollapsed]);

  useEffect(() => {
    saveExplorerCollapsed(explorerCollapsed);
  }, [explorerCollapsed]);

  useEffect(() => {
    saveExplorerWidth(explorerWidth);
  }, [explorerWidth]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await fetchAuthStatus();
        if (status.needs_setup) {
          setAuthPhase("setup");
          setBootReady(true);
          return;
        }
        await ensureApiToken();
        if (status.multi_user && !getStoredToken()) {
          setAuthPhase("login");
          setBootReady(true);
          return;
        }
        const again = await fetchAuthStatus();
        if (again.user) setAccountUser(again.user);
        if (status.multi_user && !again.authenticated && !getStoredToken()) {
          setAuthPhase("login");
          setBootReady(true);
          return;
        }
        setAuthPhase("ok");
        await session.boot();
      } catch (e) {
        setHealth({ ok: false, demo: true, model: "offline", workspace: String(e) });
        setAuthPhase("ok");
        setBootReady(true);
      }
    })();
  }, []);

  const finishAuth = async () => {
    setAuthPhase("ok");
    setBootReady(false);
    try {
      const me = await fetchAuthStatus();
      if (me.user) setAccountUser(me.user);
      await session.boot();
    } catch (e) {
      setHealth({ ok: false, demo: true, model: "offline", workspace: String(e) });
      setBootReady(true);
    }
  };

  useEffect(() => {
    if (sessionId) saveActiveSessionId(sessionId, activeWs?.path || null);
  }, [sessionId, activeWs?.path]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      if (mq.matches) setExplorerCollapsed(true);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (health?.context_limit) {
      setCtx((c) => ({ ...c, limit: health.context_limit || c.limit }));
    }
  }, [health?.context_limit]);

  useEffect(() => {
    if (!stickBottomRef.current) return;
    const el = threadRef.current;
    if (el) {
      // Re-check: user may have scrolled away between the render and this effect.
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist >= 80) {
        stickBottomRef.current = false;
        return;
      }
      el.scrollTop = el.scrollHeight;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [messages, busy, compressState?.active]);

  // Unpin stick-to-bottom as soon as the user scrolls up (wheel/touch), so
  // streaming token updates cannot yank the viewport back down.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const unpinIfUp = (deltaY: number) => {
      if (deltaY < 0) stickBottomRef.current = false;
    };
    const onWheel = (e: WheelEvent) => unpinIfUp(e.deltaY);
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY != null && y != null) unpinIfUp(touchY - y);
      touchY = y ?? touchY;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [bootReady]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizingRef.current) {
        // Browser preview needs a wide panel; allow up to ~72% of the window.
        const maxW = Math.min(1200, Math.max(520, Math.floor(window.innerWidth * 0.72)));
        const next = Math.min(maxW, Math.max(200, e.clientX - 64));
        setExplorerWidth(next);
        setExplorerCollapsed(false);
      }
      if (resizingDetailRef.current) {
        const fromRight = window.innerWidth - e.clientX - 12;
        const next = Math.min(720, Math.max(280, fromRight));
        setDetailWidth(next);
      }
    };
    const onUp = () => {
      resizingRef.current = false;
      resizingDetailRef.current = false;
      document.body.classList.remove("resizing-sidebar");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (approval || askPrompt || planConfirm) return;
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (sidePanel === "history" && !explorerCollapsed) {
          setExplorerCollapsed(true);
          return;
        }
        if (detail) {
          if (detail.type === "changes" && detail.selectedPath) {
            setDetail({ type: "changes", selectedPath: null });
            return;
          }
          setDetail(null);
          return;
        }
        if (input.startsWith("/")) {
          setInput("");
          return;
        }
      }

      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void actions.newChat();
        return;
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        session.openHistoryPanel();
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        dialogs.openSettings();
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        composerRef.current?.focus();
        setInput((v) => (v.startsWith("/") ? v : "/"));
        return;
      }
      if (!typing && e.key === "/" && !mod && !e.altKey) {
        e.preventDefault();
        composerRef.current?.focus();
        setInput("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval, askPrompt, settingsOpen, sidePanel, explorerCollapsed, detail, input, sessionsPage, planConfirm]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottomRef.current = dist < 80;
  }

  function openDetail(d: DetailView) {
    // Inspecting prior tool/file results: stop following the live stream.
    stickBottomRef.current = false;
    setDetail(d);
  }

  const brandSub = useMemo(() => {
    if (!health) return "启动中…";
    if (model?.demo_mode || health.demo) return "Demo";
    const ref = modelSwitchRole === "subagent" ? model?.subagent : model?.main;
    const label = modelLabel(model, ref);
    if (label) return label;
    return health.model || "model";
  }, [health, model, modelSwitchRole]);

  const slashQuery = useMemo(() => slashMenuQuery(input), [input]);
  const slashItems = useMemo(
    () => (slashQuery != null ? buildSlashMenuItems(slashQuery, skills, locale) : []),
    [slashQuery, skills, locale],
  );
  const slashOpen = slashQuery != null;
  const atFileQuery = useMemo(
    () => (slashOpen ? null : atFileMenuQuery(input)),
    [input, slashOpen],
  );
  const atFileOpen = atFileQuery != null;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (!approval || !isFileMutatingTool(approval.name)) {
      setApprovalDiff(null);
      setApprovalDiffLoading(false);
      return;
    }
    let cancelled = false;
    setApprovalDiff(null);
    setApprovalDiffLoading(true);
    void buildFileDiff(approval.name, approval.args)
      .then((d) => {
        if (!cancelled) setApprovalDiff(d);
      })
      .catch(() => {
        if (!cancelled) setApprovalDiff(null);
      })
      .finally(() => {
        if (!cancelled) setApprovalDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // key captures name/args/callId identity
  }, [approval, approval ? toolDiffKey(approval.name, approval.args, approval.callId) : ""]);

  useEffect(() => {
    if (!detail || detail.type !== "tool" || !isFileMutatingTool(detail.tool.name)) {
      setDetailDiff(null);
      setDetailDiffLoading(false);
      return;
    }
    // Args are incomplete while streaming — rebuilding diff every chunk causes panel flicker.
    if (detail.tool.status === "streaming") {
      setDetailDiff(null);
      setDetailDiffLoading(false);
      return;
    }
    const tool = detail.tool;
    let cancelled = false;
    setDetailDiff(null);
    setDetailDiffLoading(true);
    void buildFileDiff(tool.name, tool.args)
      .then((d) => {
        if (!cancelled) setDetailDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDetailDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDetailDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    detail?.type === "tool" ? detail.tool.status : "",
    detail?.type === "tool"
      ? toolDiffKey(detail.tool.name, detail.tool.args, detail.tool.callId)
      : "",
  ]);

  // Keep streaming tool preview pinned to the latest chunk.
  useEffect(() => {
    if (detail?.type !== "tool" || detail.tool.status !== "streaming") return;
    const el = document.querySelector(".detail-stream") as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    detail?.type === "tool" ? detail.tool.status : "",
    detail?.type === "tool" ? detail.tool.argsRaw : "",
    detail?.type === "tool" ? writeFilePreview(detail.tool.args)?.content?.length : 0,
  ]);

  useEffect(() => {
    setAtFileIndex(0);
  }, [atFileQuery]);

  useEffect(() => {
    if (atFileQuery == null) {
      setAtFileHits([]);
      setAtFileLoading(false);
      return;
    }
    if (!activeWs?.path) {
      setAtFileHits([]);
      return;
    }
    let cancelled = false;
    setAtFileLoading(true);
    const q = atFileQuery.trim();
    const timer = window.setTimeout(() => {
      const run = async () => {
        try {
          if (!q) {
            const listed = await listFiles(".");
            if (cancelled) return;
            const files = (listed.entries || [])
              .filter((e) => e.type === "file")
              .slice(0, 40)
              .map((e) => ({
                path: e.path,
                name: e.name,
                kind: e.kind || "file",
              }));
            setAtFileHits(files);
            return;
          }
          const res = await searchFiles(q, ".");
          if (cancelled) return;
          const files = (res.hits || [])
            .filter((h) => h.kind !== "dir")
            .slice(0, 40)
            .map((h) => ({
              path: h.path,
              name: h.name || h.path.split("/").pop() || h.path,
              kind: h.kind,
              match: h.match,
            }));
          const seen = new Set<string>();
          const uniq = files.filter((f) => {
            if (seen.has(f.path)) return false;
            seen.add(f.path);
            return true;
          });
          setAtFileHits(uniq);
        } catch {
          if (!cancelled) setAtFileHits([]);
        } finally {
          if (!cancelled) setAtFileLoading(false);
        }
      };
      void run();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atFileQuery, activeWs?.path]);

  const ctxPct = Math.min(100, Math.round((ctx.tokens / Math.max(1, ctx.limit)) * 100));
  const ctxWarn = ctxPct >= 72;
  const needsWorkspace = bootReady && authPhase === "ok" && !activeWs?.path;

  return (
    <div className="shell">
      <div className="wash" aria-hidden />
      <header className="top">
        <div className="top-left">
          <div className="brand">
            <span className="brand-mark brand-mark-anim">
              <IconRobotCube size={30} />
            </span>
            <div className="brand-text">
              <strong>Sidekick</strong>
              <span>{t("tagline")}</span>
            </div>
          </div>
          {Boolean(activeWs?.path) && (
            <>
              <button
                type="button"
                className="chip action iconed"
                onClick={() => session.openHistoryPanel()}
              >
                <IconClock size={15} />
                <span>{t("history")}</span>
              </button>
              <button type="button" className="chip action iconed" onClick={() => void actions.newChat()}>
                <IconPlus size={15} />
                <span>{t("newChat")}</span>
              </button>
            </>
          )}
        </div>
        <div className="top-right">
          <button
            type="button"
            className="theme-toggle"
            title={theme === "dark" ? t("themeLight") : t("themeDark")}
            aria-label={theme === "dark" ? t("themeLight") : t("themeDark")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

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
        <div className="confirm-banner" role="dialog" aria-label="确认操作">
          <div className="confirm-banner-text">
            <strong>{pendingConfirm.title}</strong>
            {pendingConfirm.detail && <span>{pendingConfirm.detail}</span>}
          </div>
          <div className="confirm-banner-actions">
            <button
              type="button"
              className="fe-inline-btn cancel"
              title="取消"
              onClick={() => setPendingConfirm(null)}
            >
              ✕            </button>
            <button
              type="button"
              className="fe-inline-btn ok"
              title={pendingConfirm.confirmLabel || "确认"}
              onClick={() => {
                const action = pendingConfirm;
                setPendingConfirm(null);
                void Promise.resolve(action.run()).catch((e) =>
                  setToast(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              ✕            </button>
          </div>
        </div>
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
              sessions={sessions}
              sessionId={sessionId}
              sessionsPage={sessionsPage}
              sessionsTotalPages={sessionsTotalPages}
              sessionsTotal={sessionsTotal}
              onOpenHistoryPanel={session.openHistoryPanel}
              onRefreshSessions={session.refreshSessions}
              onOpenSession={actions.openSession}
              onNewChat={actions.newChat}
              onDeleteSession={actions.removeSession}
              onOpenSettings={() => dialogs.openSettings()}
              onOpenFile={(file, opts) => openDetail(fileToDetail(file, opts))}
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
              onWorkspaceMutated={() => setFsRefresh((n) => n + 1)}
              mainView={mainView}
              onOpenMemory={() => {
                setMainView("memory");
                setExplorerCollapsed(true);
                setSettingsOpen(false);
              }}
              onOpenChat={() => setMainView("chat")}
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
            slashOpen={slashOpen}
            slashItems={slashItems}
            slashIndex={slashIndex}
            setSlashIndex={setSlashIndex}
            atFileOpen={atFileOpen}
            atFileHits={atFileHits}
            atFileIndex={atFileIndex}
            setAtFileIndex={setAtFileIndex}
            atFileLoading={atFileLoading}
            queued={queued}
            activePlan={activePlan}
            planConfirm={planConfirm}
            planConfirmSubmitting={planConfirmSubmitting}
            approval={approval}
            approvalDiff={approvalDiff}
            approvalDiffLoading={approvalDiffLoading}
            askPrompt={askPrompt}
            askChoice={askChoice}
            askOtherText={askOtherText}
            askSubmitting={askSubmitting}
            ctxPct={ctxPct}
            ctxWarn={ctxWarn}
            ctx={ctx}
            model={model}
            modelSwitchRole={modelSwitchRole}
            setModelSwitchRole={setModelSwitchRole}
            onSend={actions.send}
            onStopChat={chat.stopChat}
            onApplySlashItem={actions.applySlashItem}
            onApplyAtFile={actions.applyAtFile}
            onAddAttachments={actions.addAttachments}
            onClearQueued={chat.clearQueued}
            onRemoveQueued={chat.removeQueued}
            onResolvePlanConfirm={dialogs.resolvePlanConfirm}
            onResolveApproval={dialogs.resolveApproval}
            onResolveAsk={dialogs.resolveAsk}
            setAskChoice={setAskChoice}
            setAskOtherText={setAskOtherText}
            onOpenSettings={dialogs.openSettings}
            onSwitchModelRole={dialogs.switchModelRole}
            gitRefreshKey={fsRefresh}
            sessionId={sessionId}
            onOpenReview={() => openDetail({ type: "changes", selectedPath: null })}
          />
        </section>
        {detail && (
          <>
            <div
              className="sidebar-resizer detail-resizer"
              onMouseDown={() => {
                resizingDetailRef.current = true;
                document.body.classList.add("resizing-sidebar");
              }}
              title="拖拽调整预览宽度"
            />
            <aside className="detail-panel" style={{ width: detailWidth }}>
            <div className="detail-head">
              <h3>
                {detail.type === "tool"
                  ? `${t("detailTool")} · ${detail.tool.name}`
                  : detail.type === "subagent"
                    ? `${t("detailSubagent")} · ${detail.subagent.role || "leaf"}`
                    : detail.type === "changes"
                      ? t("gitReviewList")
                      : detail.path}
              </h3>
              <div className="detail-actions">
                {detail.type === "file" &&
                  detail.kind === "text" &&
                  detail.editable &&
                  !detail.forceEdit &&
                  !detail.dirty && (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => setDetail({ ...detail, forceEdit: true })}
                  >
                    {locale === "en" ? "Edit" : "编辑"}
                  </button>
                )}
                {detail.type === "file" && detail.editable && (
                  <button
                    type="button"
                    className="mini"
                    disabled={!detail.dirty}
                    onClick={() => void dialogs.saveDetailFile()}
                  >
                    {locale === "en" ? "Save" : "保存"}
                  </button>
                )}
                {detail.type === "file" && detail.rawUrl && detail.kind !== "text" && (
                  <a className="mini linkish" href={detail.rawUrl} target="_blank" rel="noreferrer">
                    {locale === "en" ? "Open / Download" : "打开/下载"}
                  </a>
                )}
                <button
                  type="button"
                  className="icon-btn detail-close"
                  title={t("detailClose")}
                  aria-label={t("detailClose")}
                  onClick={() => setDetail(null)}
                >
                  <IconX size={16} />
                </button>
              </div>
            </div>
            {detail.type === "tool" ? (
              <div className="detail-body">
                <div className="detail-meta">
                  {t("detailStatus")}
                  {detail.tool.status === "streaming"
                    ? t("toolStatusStreaming")
                    : detail.tool.status === "running" || detail.tool.status === "pending"
                      ? t("toolStatusRunning")
                      : detail.tool.status === "error"
                        ? t("toolStatusError")
                        : detail.tool.status === "done"
                          ? t("toolStatusDone")
                          : detail.tool.status}
                </div>
                {detail.tool.name && isFileMutatingTool(detail.tool.name) ? (
                  detail.tool.status === "streaming" ? (
                    (() => {
                      const preview = writeFilePreview(detail.tool.args);
                      return (
                        <>
                          <div className="detail-meta">
                            {t("toolStatusStreaming")}
                            {preview?.path ? ` · ${preview.path}` : ""}
                          </div>
                          <h4>{preview ? (locale === "en" ? "Content" : "内容") : t("detailArgs")}</h4>
                          <pre className="code-fence detail-stream">
                            {preview
                              ? preview.content
                              : detail.tool.argsRaw || formatArgs(detail.tool.args)}
                          </pre>
                        </>
                      );
                    })()
                  ) : (
                    <>
                      <h4>{t("diffPreview")}</h4>
                      <DiffReview
                        diff={detailDiff}
                        loading={detailDiffLoading}
                        title={t("diffPreview")}
                        newFileLabel={t("diffNewFile")}
                        truncatedLabel={t("diffTruncated")}
                        emptyLabel={t("diffEmpty")}
                        alreadyAppliedLabel={t("diffAlreadyApplied")}
                        snippetLabel={t("diffSnippet")}
                      />
                    </>
                  )
                ) : (
                  <>
                    <h4>{t("detailArgs")}</h4>
                    <pre className="code-fence">
                      {detail.tool.argsRaw && detail.tool.status === "streaming"
                        ? detail.tool.argsRaw
                        : formatArgs(detail.tool.args)}
                    </pre>
                  </>
                )}
                {detail.tool.status !== "streaming" || !isFileMutatingTool(detail.tool.name) ? (
                  <>
                    <h4>{t("detailOutput")}</h4>
                    <LinkifiedText
                      className="code-fence"
                      text={
                        detail.tool.result ||
                        (detail.tool.status === "streaming"
                          ? t("toolArgsStreaming")
                          : detail.tool.status === "running" || detail.tool.status === "pending"
                            ? t("toolRunning")
                            : t("toolNoOutput"))
                      }
                      onCtrlClickUrl={(url, x, y) =>
              setSandboxUrlPrompt({ url: sanitizeBrowserUrl(url) || url, x, y })
            }
                    />
                  </>
                ) : null}
              </div>
            ) : detail.type === "subagent" ? (
              <div className="detail-body subagent-detail">
                <div className="detail-meta">
                  {detail.subagent.status === "running"
                    ? t("toolStatusRunning")
                    : detail.subagent.status === "error"
                      ? t("toolStatusFailStop")
                      : t("subagentDone")}
                  {detail.subagent.activity ? ` · ${detail.subagent.activity}` : ""}
                </div>
                <p className="subagent-detail-goal">{detail.subagent.goal}</p>
                <div className="subagent-detail-thread">
                  {(detail.subagent.transcript || []).length === 0 && (
                    <p className="hint">{t("subagentWaiting")}</p>
                  )}
                  {(detail.subagent.transcript || []).map((item) => {
                    if (item.kind === "assistant") {
                      return (
                        <article
                          key={item.id}
                          className={`bubble assistant${item.streaming ? " streaming" : ""}`}
                        >
                          <div className="role">
                            {t("subagentLabel")}
                            {item.streaming
                              ? item.reasoningStreaming
                                ? ` · ${t("thinking")}`
                                : ` · ${t("outputting")}`
                              : ""}
                          </div>
                          {(item.reasoning || item.reasoningStreaming) && (
                            <ThinkingBlock
                              content={item.reasoning || ""}
                              streaming={Boolean(item.reasoningStreaming)}
                            />
                          )}
                          {item.text ? (
                            <MarkdownView
                              content={item.text}
                              streaming={item.streaming && !item.reasoningStreaming}
                              onCtrlClickUrl={(url, x, y) =>
                                setSandboxUrlPrompt({
                                  url: sanitizeBrowserUrl(url) || url,
                                  x,
                                  y,
                                })
                              }
                            />
                          ) : null}
                        </article>
                      );
                    }
                    const tool = item.tool;
                    return (
                      <div
                        key={item.id}
                        className={`tool-chip ${tool.status}`}
                        title={tool.summary}
                      >
                        <span className="tool-chip-mark">
                          {tool.status === "pending"
                            ? "?"
                            : tool.status === "streaming" || tool.status === "running"
                              ? "…"
                              : tool.status === "error"
                                ? "!"
                                : "…"}
                        </span>
                        <span className="tool-chip-body">
                          <span className="tool-chip-name">{tool.name}</span>
                          <span className="tool-chip-summary">{tool.summary}</span>
                        </span>
                        {tool.result && (
                          <LinkifiedText
                            className="subagent-tool-result"
                            text={tool.result.slice(0, 2000)}
                            onCtrlClickUrl={(url, x, y) =>
                              setSandboxUrlPrompt({
                                url: sanitizeBrowserUrl(url) || url,
                                x,
                                y,
                              })
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                {detail.subagent.summary && detail.subagent.status !== "running" && (
                  <>
                    <h4>{t("subagentFinalSummary")}</h4>
                    <pre className="code-fence">{detail.subagent.summary}</pre>
                  </>
                )}
              </div>
            ) : detail.type === "changes" ? (
              <ReviewPanel
                t={t}
                refreshKey={fsRefresh}
                sessionId={sessionId}
                selectedPath={detail.selectedPath}
                onSelectPath={(path) => setDetail({ type: "changes", selectedPath: path })}
              />
            ) : (
              <div className="detail-body file-preview">
                <div className="detail-meta">
                  {detail.kind}
                  {detail.mime ? ` · ${detail.mime}` : ""}
                  {detail.size != null ? ` · ${formatBytes(detail.size)}` : ""}
                  {detail.kind === "text"
                    ? ` · ${countTextLines(detail.content || "")} lines`
                    : ""}
                </div>
                {detail.kind === "image" && detail.rawUrl && (
                  <div className="media-frame">
                    <img src={detail.rawUrl} alt={detail.path} />
                  </div>
                )}
                {detail.kind === "pdf" && detail.rawUrl && (
                  <iframe className="pdf-frame" title={detail.path} src={detail.rawUrl} />
                )}
                {detail.kind === "audio" && detail.rawUrl && (
                  <audio className="media-player" controls src={detail.rawUrl} />
                )}
                {detail.kind === "video" && detail.rawUrl && (
                  <video className="media-player" controls src={detail.rawUrl} />
                )}
                {detail.kind === "document" && (
                  <div className="office-preview">
                    <p className="hint">
                      {detail.message || "文本预览（非完整排版）"}。需要原文件请点「打开/下载」。                    </p>
                    <pre className="code-fence office-text">
                      {detail.preview || "（无文字内容）"}
                    </pre>
                  </div>
                )}
                {detail.kind === "unsupported" && (
                  <div className="unsupported-preview">
                    <p className="hint unsupported-msg">
                      {detail.message || "暂不支持预览此文件"}
                    </p>
                    {detail.rawUrl && (
                      <p className="hint">可使用「打开/下载」在系统中查看原文件。</p>
                    )}
                  </div>
                )}
                {detail.kind === "text" && !detail.forceEdit && !detail.dirty ? (
                    <FileHighlightView
                      content={detail.content}
                      query={detail.highlightQuery || ""}
                      focusLine={detail.focusLine}
                    />
                  ) : detail.kind === "text" ? (
                    <FileTextEditor
                      value={detail.content}
                      readOnly={!detail.editable}
                      onChange={(content) =>
                        setDetail({ ...detail, content, dirty: true })
                      }
                    />
                  ) : null}
              </div>
            )}
          </aside>
          </>
        )}
          </>
        )}
          </>
        )}
      </main>

      {editRestorePrompt && (
        <div
          className="modal-backdrop"
          onClick={() => setEditRestorePrompt(null)}
          role="presentation"
        >
          <div
            className="modal edit-restore-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("editRestoreTitle")}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{t("editRestoreTitle")}</h2>
              <button type="button" onClick={() => setEditRestorePrompt(null)}>
                {t("close")}
              </button>
            </div>
            <div className="modal-body">
              <p className="hint">{t("editRestoreBody")}</p>
              <div className="edit-restore-actions">
                <button
                  type="button"
                  className="bubble-edit-btn cancel"
                  onClick={() => setEditRestorePrompt(null)}
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  className="bubble-edit-btn"
                  onClick={() => void actions.submitEdit(editRestorePrompt.msgId, false)}
                >
                  {t("editRestoreChatOnly")}
                </button>
                <button
                  type="button"
                  className="bubble-edit-btn primary"
                  onClick={() => void actions.submitEdit(editRestorePrompt.msgId, true)}
                >
                  {t("editRestoreWithFiles")}
                </button>
              </div>
            </div>
          </div>
        </div>
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
          model={model}
          modelSaving={modelSaving}
          onModelChange={setModel}
          onModelSave={dialogs.applyModel}
          subs={subs}
          live={live}
          accountUser={accountUser}
          onToast={(msg) => setToast(msg)}
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
