import type { SidePanel } from "../layoutPersist";
import { FileExplorer } from "./FileExplorer";
import { FileSearchPanel } from "./FileSearchPanel";
import { HistoryPanel } from "./HistoryPanel";
import { BrowserPanel, type BrowserOpenRequest } from "./BrowserPanel";
import { GitPanel } from "./GitPanel";
import { UndoTimeline } from "./UndoTimeline";
import { IconBook, IconClock, IconFiles, IconGit, IconGlobe, IconSearch, IconSettings, IconTerminal, IconUndo, IconX } from "./icons";
import { ShellJobsPanel } from "./ShellJobsPanel";
import { IconRobotCube } from "./IconRobotCube";
import { useMemo } from "react";
import type { SessionItem, WorkspaceItem } from "../api";
import { fileToDetail } from "../utils/chatHelpers";
import type { MsgKey } from "../i18n";
import type { DomElementPayload } from "../browser/protocol";

export type ActivitySidebarProps = {
  t: (key: MsgKey, ...args: string[]) => string;
  sidePanel: SidePanel;
  setSidePanel: (panel: SidePanel) => void;
  explorerCollapsed: boolean;
  setExplorerCollapsed: (v: boolean) => void;
  explorerWidth: number;
  fsRefresh: number;
  activeWs: { path: string; name: string } | null;
  workspaces?: WorkspaceItem[];
  /** Workspaces backing currently-open chat tabs (drives the hub row alongside `workspaces`). */
  openTabWorkspaces?: { path: string; name: string; running: boolean }[];
  sessions: SessionItem[];
  sessionId: string | null;
  sessionsPage: number;
  sessionsTotalPages: number;
  sessionsTotal: number;
  onOpenHistoryPanel: () => void;
  onRefreshSessions: (page?: number) => void;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
  /** Switch the active chat/workspace to `path` (opens an existing tab or starts a new one). */
  onSwitchWorkspace?: (path: string) => void;
  /** Remove a folder from the recent/hub workspace list. */
  onForgetWorkspace?: (path: string) => void;
  onDeleteSession: (id: string) => Promise<void>;
  onOpenSettings: () => void;
  onOpenFile: (file: Parameters<typeof fileToDetail>[0], opts?: Parameters<typeof fileToDetail>[1]) => void;
  onFileDeleted: (path: string) => void;
  /** File currently shown in the detail pane, if any. */
  activeFilePath?: string | null;
  onResizeStart: () => void;
  onPickDomElement: (el: DomElementPayload) => void;
  browserOpenRequest?: BrowserOpenRequest | null;
  browserSuspended?: boolean;
  onWorkspaceMutated?: () => void;
  mainView?: "chat" | "memory";
  onOpenMemory?: () => void;
  onOpenChat?: () => void;
  jobsRunning?: number;
  jobsFocusId?: string;
  jobsRefreshKey?: number;
};

export function ActivitySidebar({
  t,
  sidePanel,
  setSidePanel,
  explorerCollapsed,
  setExplorerCollapsed,
  explorerWidth,
  fsRefresh,
  activeWs,
  workspaces = [],
  openTabWorkspaces = [],
  sessions,
  sessionId,
  sessionsPage,
  sessionsTotalPages,
  sessionsTotal,
  onOpenHistoryPanel,
  onRefreshSessions,
  onOpenSession,
  onNewChat,
  onSwitchWorkspace,
  onForgetWorkspace,
  onDeleteSession,
  onOpenSettings,
  onOpenFile,
  onFileDeleted,
  activeFilePath = null,
  onResizeStart,
  onPickDomElement,
  browserOpenRequest,
  browserSuspended = false,
  onWorkspaceMutated,
  mainView = "chat",
  onOpenMemory,
  onOpenChat,
  jobsRunning = 0,
  jobsFocusId = "",
  jobsRefreshKey = 0,
}: ActivitySidebarProps) {
  const showChat = () => onOpenChat?.();

  const hubWorkspaces = useMemo(() => {
    const byPath = new Map<string, { path: string; name: string; running: number }>();
    const bump = (path: string, name: string) => {
      if (!path) return;
      if (byPath.has(path)) return;
      byPath.set(path, { path, name: name || path, running: 0 });
    };
    // Only "known" workspaces (recent list + currently-open chat tabs) show
    // up here — removing a workspace drops its tabs too, so it disappears
    // from this row immediately instead of lingering via old chat history.
    if (activeWs?.path) bump(activeWs.path, activeWs.name);
    for (const w of workspaces) bump(w.path, w.name);
    for (const w of openTabWorkspaces) bump(w.path, w.name);
    for (const w of openTabWorkspaces) {
      if (w.running && byPath.has(w.path)) byPath.get(w.path)!.running += 1;
    }
    return [...byPath.values()];
  }, [activeWs, workspaces, openTabWorkspaces]);

  const showHub = hubWorkspaces.length > 1;
  const hubRow = showHub ? (
    <WorkspaceHubRow
      workspaces={hubWorkspaces}
      activePath={activeWs?.path || ""}
      onPick={(path) => onSwitchWorkspace?.(path)}
      onRemove={onForgetWorkspace}
    />
  ) : null;

  return (
    <>
      <nav className="activity-rail" aria-label="Sidekick">
        <button
          type="button"
          className="activity-brand"
          title="Sidekick"
          onClick={() => {
            setSidePanel("files");
            setExplorerCollapsed(false);
          }}
        >
          <IconRobotCube size={26} />
        </button>
        <div className="activity-top">
          <button
            type="button"
            className={`activity-btn${sidePanel === "search" && !explorerCollapsed ? " active" : ""}`}
            title={t("navSearch")}
            onClick={() => {
              setSidePanel("search");
              setExplorerCollapsed(false);
            }}
          >
            <IconSearch size={18} />
            <span>{t("navSearch")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "files" && !explorerCollapsed ? " active" : ""}`}
            title={t("navFiles")}
            onClick={() => {
              if (sidePanel === "files" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                setSidePanel("files");
                setExplorerCollapsed(false);
              }
            }}
          >
            <IconFiles size={18} />
            <span>{t("navFiles")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "browser" && !explorerCollapsed ? " active" : ""}`}
            title={t("navBrowser")}
            onClick={() => {
              if (sidePanel === "browser" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                setSidePanel("browser");
                setExplorerCollapsed(false);
              }
            }}
            data-panel="browser"
          >
            <IconGlobe size={18} />
            <span>{t("navBrowser")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "git" && !explorerCollapsed ? " active" : ""}`}
            title={t("navGit")}
            onClick={() => {
              if (sidePanel === "git" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                setSidePanel("git");
                setExplorerCollapsed(false);
              }
            }}
          >
            <IconGit size={18} />
            <span>{t("navGit")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "jobs" && !explorerCollapsed ? " active" : ""}${jobsRunning > 0 ? " has-badge" : ""}`}
            title={t("navJobs")}
            onClick={() => {
              showChat();
              if (sidePanel === "jobs" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                setSidePanel("jobs");
                setExplorerCollapsed(false);
              }
            }}
            data-panel="jobs"
          >
            <span className="activity-ico">
              <IconTerminal size={18} />
              {jobsRunning > 0 ? <i className="activity-badge">{jobsRunning > 9 ? "9+" : jobsRunning}</i> : null}
            </span>
            <span>{t("navJobs")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "undo" && !explorerCollapsed ? " active" : ""}`}
            title={t("navUndo")}
            onClick={() => {
              showChat();
              if (sidePanel === "undo" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                setSidePanel("undo");
                setExplorerCollapsed(false);
              }
            }}
          >
            <IconUndo size={18} />
            <span>{t("navUndo")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${mainView === "memory" ? " active" : ""}`}
            title={t("navMemory")}
            onClick={() => {
              if (mainView === "memory") showChat();
              else onOpenMemory?.();
            }}
          >
            <IconBook size={18} />
            <span>{t("navMemory")}</span>
          </button>
          <button
            type="button"
            className={`activity-btn${sidePanel === "history" && !explorerCollapsed && mainView !== "memory" ? " active" : ""}`}
            title={t("history")}
            onClick={() => {
              showChat();
              if (sidePanel === "history" && !explorerCollapsed) {
                setExplorerCollapsed(true);
              } else {
                onOpenHistoryPanel();
              }
            }}
          >
            <IconClock size={18} />
            <span>{t("history")}</span>
          </button>
        </div>
        <div className="activity-bottom">
          <button
            type="button"
            className="activity-btn"
            title={t("navSettings")}
            onClick={onOpenSettings}
          >
            <IconSettings size={18} />
            <span>{t("navSettings")}</span>
          </button>
        </div>
      </nav>

      {!explorerCollapsed && (
        <>
          {sidePanel === "search" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <FileSearchPanel
                refreshKey={fsRefresh}
                activeFilePath={activeFilePath}
                workspace={activeWs?.path || null}
                onOpenFile={(file, opts) => onOpenFile(file, opts)}
              />
            </div>
          ) : sidePanel === "history" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <HistoryPanel
                sessions={sessions}
                activeSessionId={sessionId}
                page={sessionsPage}
                totalPages={sessionsTotalPages}
                total={sessionsTotal}
                onRefresh={() => void onRefreshSessions(sessionsPage)}
                onPageChange={(p) => void onRefreshSessions(p)}
                onOpen={(id) => void onOpenSession(id)}
                onNew={() => void onNewChat()}
                onDelete={(id) => onDeleteSession(id)}
              />
            </div>
          ) : sidePanel === "browser" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <BrowserPanel
                onPickElement={onPickDomElement}
                openRequest={browserOpenRequest}
                suspended={browserSuspended}
              />
            </div>
          ) : sidePanel === "git" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <GitPanel
                refreshKey={fsRefresh}
                onChanged={onWorkspaceMutated}
                workspace={activeWs?.path || null}
              />
            </div>
          ) : sidePanel === "jobs" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <ShellJobsPanel refreshKey={jobsRefreshKey} focusJobId={jobsFocusId} />
            </div>
          ) : sidePanel === "undo" ? (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <UndoTimeline
                refreshKey={fsRefresh}
                sessionId={sessionId}
                onRestored={onWorkspaceMutated}
              />
            </div>
          ) : (
            <div className="side-panel-wrap ws-hub-wrap" style={{ width: explorerWidth }}>
              {hubRow}
              <FileExplorer
                rootName={activeWs?.name || "workspace"}
                workspaceAbsPath={activeWs?.path || null}
                collapsed={false}
                width={explorerWidth}
                onToggle={() => setExplorerCollapsed(true)}
                refreshKey={fsRefresh}
                onOpenFile={(file) => onOpenFile(file)}
                onDeleted={onFileDeleted}
                activeFilePath={activeFilePath}
              />
            </div>
          )}
          <div
            className="sidebar-resizer"
            onMouseDown={(e) => {
              e.preventDefault();
              onResizeStart();
            }}
            title="拖拽调整宽度"
          />
        </>
      )}
    </>
  );
}

/**
 * Hub strip shown above every side panel (except Memory): every workspace
 * that currently has an open or running chat. Clicking a pill actually
 * switches the active chat — opening its existing tab, or starting a new
 * one — so every panel (search/files/browser/git/jobs/undo/history) follows
 * along automatically.
 */
function WorkspaceHubRow({
  workspaces,
  activePath,
  onPick,
  onRemove,
}: {
  workspaces: { path: string; name: string; running: number }[];
  activePath: string;
  onPick: (path: string, name: string) => void;
  onRemove?: (path: string) => void;
}) {
  return (
    <div className="ws-hub-row" role="tablist" aria-label="工作区">
      {workspaces.map((w) => {
        const active = w.path === activePath;
        return (
          <button
            key={w.path}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ws-hub-pill${active ? " active" : ""}`}
            title={w.path}
            onClick={() => onPick(w.path, w.name)}
          >
            {w.running > 0 && <span className="ws-hub-dot" />}
            <span className="ws-hub-pill-name">{w.name}</span>
            {onRemove && !active && (
              <span
                className="ws-hub-pill-remove"
                role="button"
                tabIndex={0}
                title="移除工作区"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(w.path);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove(w.path);
                  }
                }}
              >
                <IconX size={10} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
