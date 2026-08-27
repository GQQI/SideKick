import { useCallback, useRef } from "react";
import {
  ensureApiToken,
  fetchHealth,
  fetchMemory,
  fetchModel,
  fetchSession,
  fetchSessions,
  fetchSkills,
  fetchWorkspaces,
  HISTORY_PAGE_SIZE,
  type Health,
  type SessionDetail,
} from "../api";
import { loadActiveSessionId } from "../sessionPersist";
import { mapSessionMessages } from "../utils/chatHelpers";
import type { ModelSetup } from "../types/modelSetup";
import type { ChatMsg } from "../types/chat";
import type { SkillItem, SessionItem, WorkspaceItem } from "../api";

export type SessionBootstrapDeps = {
  sessionsPage: number;
  setHealth: (h: Health | null) => void;
  setWorkspaces: (w: WorkspaceItem[]) => void;
  setActiveWs: (w: { path: string; name: string } | null) => void;
  setBootReady: (v: boolean) => void;
  setSessionId: (id: string | null) => void;
  setSkills: (s: SkillItem[]) => void;
  setMemory: (m: string) => void;
  setModel: (m: ModelSetup | null) => void;
  setSessions: (s: SessionItem[]) => void;
  setSessionsPage: (p: number) => void;
  setSessionsTotal: (n: number) => void;
  setSessionsTotalPages: (n: number) => void;
  setCtx: React.Dispatch<React.SetStateAction<{ tokens: number; limit: number }>>;
  setLive: React.Dispatch<React.SetStateAction<import("../types/chat").LiveLine[]>>;
  setSubs: React.Dispatch<React.SetStateAction<import("../types/chat").SubNode[]>>;
  commit: (next: ChatMsg[]) => void;
  streamIdRef: React.MutableRefObject<string | null>;
  streamTextRef: React.MutableRefObject<string>;
  streamReasoningRef: React.MutableRefObject<string>;
  nativeReasoningRef: React.MutableRefObject<boolean>;
  setSidePanel: (p: "files" | "search" | "history" | "browser" | "git" | "undo") => void;
  onResumeRuntime?: (detail: SessionDetail) => void;
  setExplorerCollapsed: (v: boolean) => void;
};

export function useSessionBootstrap(deps: SessionBootstrapDeps) {
  const {
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
    commit,
    streamIdRef,
    streamTextRef,
    streamReasoningRef,
    nativeReasoningRef,
    setSidePanel,
    setExplorerCollapsed,
  } = deps;
  const onResumeRuntimeRef = useRef(deps.onResumeRuntime);
  onResumeRuntimeRef.current = deps.onResumeRuntime;

  const syncContextFromSession = useCallback(
    (detail: { tokens?: number; limit?: number }) => {
      const tokens = Number(detail.tokens ?? 0);
      const limit = Number(detail.limit ?? 0);
      setCtx((c) => ({
        tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : c.limit,
      }));
    },
    [setCtx],
  );

  const resetContextUsage = useCallback(() => {
    setCtx((c) => ({ ...c, tokens: 0 }));
  }, [setCtx]);

  const applySessionDetail = useCallback(
    (detail: SessionDetail) => {
      setSessionId(detail.id);
      syncContextFromSession(detail);
      const mapped = mapSessionMessages(detail.messages);
      commit(mapped);
      streamIdRef.current = null;
      streamTextRef.current = "";
      streamReasoningRef.current = "";
      nativeReasoningRef.current = false;
      setLive([]);
      setSubs(
        mapped
          .filter((m) => m.role === "subagent" && m.subagent)
          .map((m) => m.subagent!),
      );
      onResumeRuntimeRef.current?.(detail);
    },
    [
      setSessionId,
      syncContextFromSession,
      commit,
      streamIdRef,
      streamTextRef,
      streamReasoningRef,
      nativeReasoningRef,
      setLive,
      setSubs,
    ],
  );

  const refreshSessions = useCallback(
    async (page?: number) => {
      try {
        const target = page ?? sessionsPage;
        const res = await fetchSessions(target, HISTORY_PAGE_SIZE);
        setSessions(res.items || []);
        setSessionsPage(res.page || 1);
        setSessionsTotal(res.total || 0);
        setSessionsTotalPages(res.total_pages || 1);
      } catch {
        /* ignore */
      }
    },
    [sessionsPage, setSessions, setSessionsPage, setSessionsTotal, setSessionsTotalPages],
  );

  const openHistoryPanel = useCallback(() => {
    setSidePanel("history");
    setExplorerCollapsed(false);
    void refreshSessions(sessionsPage);
  }, [setSidePanel, setExplorerCollapsed, refreshSessions, sessionsPage]);

  const refreshWorkspaces = useCallback(async () => {
    const w = await fetchWorkspaces();
    setWorkspaces(w.items);
    setActiveWs(w.active?.path ? w.active : null);
  }, [setWorkspaces, setActiveWs]);

  const restoreOrCreateSession = useCallback(
    async (workspacePath: string | null) => {
      const tryOpen = async (id: string) => {
        const detail = await fetchSession(id);
        applySessionDetail(detail);
        return true;
      };

      const saved = loadActiveSessionId(workspacePath);
      if (saved) {
        try {
          if (await tryOpen(saved)) return;
        } catch {
          /* deleted or corrupt — fall through */
        }
      }

      try {
        const list = await fetchSessions(1, HISTORY_PAGE_SIZE);
        const hit = (list.items || []).find((s) => (s.user_turns ?? 0) > 0 || s.messages > 0);
        if (hit) {
          try {
            if (await tryOpen(hit.id)) return;
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      setSessionId(null);
      commit([]);
      resetContextUsage();
    },
    [applySessionDetail, setSessionId, commit, resetContextUsage],
  );

  const boot = useCallback(async () => {
    await ensureApiToken();
    const [h, w] = await Promise.all([fetchHealth(), fetchWorkspaces()]);
    const wsPath = w.active?.path || null;
    setHealth(h);
    setWorkspaces(w.items);
    setActiveWs(wsPath ? w.active : null);
    setBootReady(true);
    await restoreOrCreateSession(wsPath);
    setSkills(await fetchSkills());
    setMemory(await fetchMemory());
    setModel(await fetchModel());
    await refreshSessions();
  }, [
    setHealth,
    setWorkspaces,
    setActiveWs,
    setBootReady,
    restoreOrCreateSession,
    setSkills,
    setMemory,
    setModel,
    refreshSessions,
  ]);

  return {
    boot,
    restoreOrCreateSession,
    refreshSessions,
    refreshWorkspaces,
    syncContextFromSession,
    resetContextUsage,
    applySessionDetail,
    openHistoryPanel,
  };
}
