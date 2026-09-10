/** Persist the open chat tabs (one per running/opened conversation) across refresh. */

export type ChatTabRef = {
  id: string;
  workspace: string;
  workspaceName: string;
  /** Stable workspace id (hash of the resolved path) — tabs are scoped by
   * this, not by comparing raw path strings, so case/slash drift can't
   * make a tab from another project "leak" into view. */
  workspaceId?: string;
};

const KEY = "sidekick.openTabs";
const MAX_TABS = 16;

export function loadOpenTabs(): ChatTabRef[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is ChatTabRef =>
          t && typeof t === "object" && typeof t.id === "string" && t.id,
      )
      .slice(0, MAX_TABS);
  } catch {
    return [];
  }
}

export function saveOpenTabs(tabs: ChatTabRef[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs.slice(0, MAX_TABS)));
  } catch {
    /* ignore quota / private mode */
  }
}
