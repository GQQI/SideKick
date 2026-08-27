import { useEffect, useRef, useState } from "react";
import {
  authLogin,
  authLogout,
  authSetup,
  type Health,
  type SessionItem,
  type SkillItem,
  type WorkspaceItem,
} from "./api";
import {
  loadExplorerCollapsed,
  loadExplorerWidth,
  loadSidePanel,
} from "./layoutPersist";
import { saveActiveSessionId } from "./sessionPersist";
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
  const [activeWs, setActiveWs] = useState<{ path: string; name: string } | null>(null);
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
    detachListener: chat.detachListener,
    setBusy,
  });

  newChatRef.current = actions.newChat;

  const historySessions = sessions.map((s) => ({
    ...s,
    busy:
      Boolean(s.busy) ||
      chat.runningSessionIds.includes(s.id) ||
      Boolean(busy && s.id === sessionId),
  }));
  const historyNeedsPoll =
    sidePanel === "history" &&
    (busy || chat.runningSessionIds.length > 0 || sessions.some((item) => item.busy));

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

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

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
              sessions={historySessions}
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
                  <DetailPanel
                    t={t}
                    locale={locale}
                    detail={detail}
                    detailWidth={detailWidth}
                    detailDiff={detailDiff}
                    detailDiffLoading={detailDiffLoading}
                    fsRefresh={fsRefresh}
                    sessionId={sessionId}
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
