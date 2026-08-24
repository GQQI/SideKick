/** Persist which chat to reopen after refresh (scoped by workspace when possible). */

const KEY = "sidekick.activeSession";

export function loadActiveSessionId(workspace?: string | null): string | null {
  try {
    if (workspace) {
      const scoped = localStorage.getItem(`${KEY}:${workspace}`);
      if (scoped) return scoped;
    }
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string | null, workspace?: string | null): void {
  try {
    if (!id) {
      if (workspace) localStorage.removeItem(`${KEY}:${workspace}`);
      else localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, id);
    if (workspace) localStorage.setItem(`${KEY}:${workspace}`, id);
  } catch {
    /* ignore quota / private mode */
  }
}
