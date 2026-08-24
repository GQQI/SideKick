import { useEffect, useRef } from "react";
import { ModelSettings } from "./ModelSettings";
import { McpSettings } from "./McpSettings";
import { IconMoon, IconSun } from "./icons";
import type { LiveLine, SettingsTab, SubNode } from "../types/chat";
import type { ModelSetup } from "../types/modelSetup";
import type { WorkspaceItem } from "../api";
import type { Density, Locale, MsgKey, Theme } from "../i18n";

const APP_VERSION = "0.3.1";

export type SettingsModalProps = {
  t: (key: MsgKey, ...args: string[]) => string;
  locale: Locale;
  theme: Theme;
  density: Density;
  setTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setDensity: (density: Density) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  onClose: () => void;
  activeWs: { path: string; name: string } | null;
  workspaces: WorkspaceItem[];
  wsBusy: boolean;
  onBrowseWorkspace: () => void;
  onSwitchWorkspace: (path: string) => void;
  model: ModelSetup | null;
  modelSaving: boolean;
  onModelChange: (next: ModelSetup) => void;
  onModelSave: (next?: ModelSetup, opts?: { restartChat?: boolean }) => void;
  memory: string;
  onMemoryChange: (text: string) => void;
  onSaveMemory: () => void;
  subs: SubNode[];
  live: LiveLine[];
  accountUser?: { id: string; username: string; email?: string } | null;
  onLogout?: () => void;
  onToast?: (msg: string) => void;
};

export function SettingsModal({
  t,
  locale,
  theme,
  density,
  setTheme,
  setLocale,
  setDensity,
  settingsTab,
  setSettingsTab,
  onClose,
  activeWs,
  workspaces,
  wsBusy,
  onBrowseWorkspace,
  onSwitchWorkspace,
  model,
  modelSaving,
  onModelChange,
  onModelSave,
  memory,
  onMemoryChange,
  onSaveMemory,
  subs,
  live,
  accountUser,
  onLogout,
  onToast,
}: SettingsModalProps) {
  const logEndRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (settingsTab !== "runtime") return;
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [settingsTab, live.length]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label={t("settings")}>
        <div className="modal-head">
          <h2>{t("settings")}</h2>
          <div className="modal-head-actions">
            <button
              type="button"
              className="theme-toggle"
              title={theme === "dark" ? t("themeLight") : t("themeDark")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </button>
            <button type="button" className="icon-btn" onClick={onClose}>
              {t("close")}
            </button>
          </div>
        </div>
        <div className="modal-tabs">
          {(
            [
              ["workspace", t("tabWorkspace")],
              ["model", t("tabModel")],
              ["mcp", "MCP"],
              ["appearance", t("tabAppearance")],
              ["memory", t("tabMemory")],
              ["runtime", t("tabRuntime")],
              ["account", "账号"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={settingsTab === id ? "active" : ""}
              onClick={() => setSettingsTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {settingsTab === "workspace" && (
            <div className="settings-pane">
              <h3>{t("workspaceTitle")}</h3>
              <p className="hint path-line">{activeWs?.path || t("workspaceNone")}</p>
              <div className="ws-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={wsBusy}
                  onClick={() => void onBrowseWorkspace()}
                >
                  {wsBusy ? t("browsing") : t("openFolder")}
                </button>
              </div>
              {workspaces.length > 0 && (
                <>
                  <h3 className="settings-subhead">{t("recentFolders")}</h3>
                  <ul className="item-list">
                    {workspaces.map((w) => (
                      <li key={w.path}>
                        <div>
                          <strong>{w.name}</strong>
                          <span>{w.path}</span>
                        </div>
                        <button
                          type="button"
                          className="mini"
                          disabled={activeWs?.path === w.path || wsBusy}
                          onClick={() => void onSwitchWorkspace(w.path)}
                        >
                          {activeWs?.path === w.path ? t("inUse") : t("switch")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {settingsTab === "model" && model && (
            <ModelSettings
              setup={model}
              locale={locale}
              saving={modelSaving}
              onChange={onModelChange}
              onSave={(next, opts) => void onModelSave(next, opts)}
              t={t}
            />
          )}

          {settingsTab === "mcp" && <McpSettings onToast={onToast} />}

          {settingsTab === "account" && (
            <div className="settings-pane">
              <h3>账号</h3>
              <p className="hint">
                {accountUser
                  ? `当前用户：${accountUser.username}${accountUser.email ? ` · ${accountUser.email}` : ""}`
                  : "尚未登录（遗留单机模式）"}
              </p>
              {onLogout && (
                <div className="account-actions">
                  <button type="button" className="ghost" onClick={() => void onLogout()}>
                    退出
                  </button>
                </div>
              )}
            </div>
          )}

          {settingsTab === "appearance" && (
            <div className="settings-pane settings-pane-fill appearance-pane">
              <header className="settings-pane-intro">
                <h3>{t("appearanceTitle")}</h3>
                <p className="hint">{t("appearanceHint")}</p>
              </header>

              <div className="settings-card-list">
                <div className="appearance-row">
                  <span className="appearance-label">{t("language")}</span>
                  <div className="seg-control" role="group" aria-label={t("language")}>
                    <button
                      type="button"
                      className={locale === "zh" ? "active" : ""}
                      onClick={() => setLocale("zh")}
                    >
                      中文
                    </button>
                    <button
                      type="button"
                      className={locale === "en" ? "active" : ""}
                      onClick={() => setLocale("en")}
                    >
                      English
                    </button>
                  </div>
                </div>

                <div className="appearance-row">
                  <span className="appearance-label">{t("theme")}</span>
                  <div className="seg-control" role="group" aria-label={t("theme")}>
                    <button
                      type="button"
                      className={theme === "light" ? "active" : ""}
                      onClick={() => setTheme("light")}
                      title={t("themeLight")}
                    >
                      <IconSun /> {t("themeLight")}
                    </button>
                    <button
                      type="button"
                      className={theme === "dark" ? "active" : ""}
                      onClick={() => setTheme("dark")}
                      title={t("themeDark")}
                    >
                      <IconMoon /> {t("themeDark")}
                    </button>
                  </div>
                </div>

                <div className="appearance-row">
                  <span className="appearance-label">{t("density")}</span>
                  <div className="seg-control" role="group" aria-label={t("density")}>
                    <button
                      type="button"
                      className={density === "comfort" ? "active" : ""}
                      onClick={() => setDensity("comfort")}
                    >
                      {t("densityComfort")}
                    </button>
                    <button
                      type="button"
                      className={density === "compact" ? "active" : ""}
                      onClick={() => setDensity("compact")}
                    >
                      {t("densityCompact")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-about-card">
                <h4>{t("aboutTitle")}</h4>
                <p className="settings-about-ver">{t("aboutVersion", APP_VERSION)}</p>
                <p className="hint">{t("aboutBlurb")}</p>
              </div>
            </div>
          )}

          {settingsTab === "memory" && (
            <div className="settings-pane settings-pane-fill memory-pane">
              <header className="settings-pane-intro">
                <h3>{t("memoryTitle")}</h3>
                <p className="hint">{t("memoryHint")}</p>
              </header>
              <textarea
                value={memory}
                placeholder={t("memoryEmptyHint")}
                onChange={(e) => onMemoryChange(e.target.value)}
              />
              <div className="memory-footer">
                <span className="hint">{t("memoryChars", String(memory.length))}</span>
                <button type="button" className="primary" onClick={() => void onSaveMemory()}>
                  {t("saveMemory")}
                </button>
              </div>
            </div>
          )}

          {settingsTab === "runtime" && (
            <div className="settings-pane settings-pane-fill logs-pane">
              <header className="settings-pane-intro">
                <h3>{t("logsTitle")}</h3>
                <p className="hint">{t("logsHint")}</p>
              </header>

              <div className="logs-grid">
                <section className="logs-panel">
                  <div className="logs-panel-head">
                    <h4>{t("runtimeEvents")}</h4>
                    <span className="logs-count">{live.length}</span>
                  </div>
                  <ul className="live-log">
                    {live.length === 0 ? (
                      <li className="logs-empty">
                        <strong>{t("runtimeEvents")}</strong>
                        <span>{t("runtimeEventsHint")}</span>
                      </li>
                    ) : (
                      live.map((l, idx) => (
                        <li key={l.id} ref={idx === live.length - 1 ? logEndRef : undefined}>
                          <code>{l.kind}</code> {l.text}
                        </li>
                      ))
                    )}
                  </ul>
                </section>

                <section className="logs-panel">
                  <div className="logs-panel-head">
                    <h4>{t("runtimeSubs")}</h4>
                    <span className="logs-count">{subs.length}</span>
                  </div>
                  {subs.length === 0 ? (
                    <div className="logs-empty">
                      <strong>{t("runtimeSubs")}</strong>
                      <span>{t("runtimeSubsHint")}</span>
                    </div>
                  ) : (
                    <ul className="sub-tree">
                      {subs.map((s) => (
                        <li key={s.id} className={s.status}>
                          <div className="sub-goal">{s.goal}</div>
                          <div className="sub-meta">
                            {s.status}
                            {s.activity ? ` · ${s.activity}` : ""}
                          </div>
                          {s.summary && <pre className="sub-sum">{s.summary}</pre>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <p className="hint logs-footnote">{t("logsClearView")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
