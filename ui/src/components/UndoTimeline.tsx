import { useCallback, useEffect, useState } from "react";
import { fetchUndo, postUndo, type UndoFileEntry, type UndoItem } from "../api";
import { usePrefs } from "../prefs";
import { IconRefresh, IconReplay, IconUndo } from "./icons";

type Props = {
  refreshKey?: number;
  sessionId?: string | null;
  onRestored?: () => void;
  onReplay?: (userTurn: number, userText: string) => void;
};

function actorLabel(
  t: (key: "ledgerActorMain" | "ledgerActorSub" | "ledgerActorUser", ...args: string[]) => string,
  actor?: string,
  custom?: string,
) {
  if (actor === "sub") return custom?.trim() || t("ledgerActorSub");
  if (actor === "main") return t("ledgerActorMain");
  if (custom?.trim()) return custom;
  return t("ledgerActorUser");
}

function fileRows(item: UndoItem): UndoFileEntry[] {
  if (item.file_entries && item.file_entries.length > 0) {
    const seen = new Set<string>();
    const out: UndoFileEntry[] = [];
    for (const entry of item.file_entries) {
      const path = entry.path || "";
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(entry);
    }
    return out;
  }
  return (item.files || []).map((path) => ({ path }));
}

export function UndoTimeline({
  refreshKey = 0,
  sessionId = null,
  onRestored,
  onReplay,
}: Props) {
  const { t, locale } = usePrefs();
  const [items, setItems] = useState<UndoItem[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    if (!sessionId) {
      setItems([]);
      setCount(0);
      setErr("");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const res = await fetchUndo(sessionId);
      setItems(res.items || []);
      setCount(res.count || 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function restore(id?: string) {
    setBusyId(id || "*");
    setErr("");
    try {
      await postUndo(id, sessionId);
      await load();
      onRestored?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  }

  async function restoreFile(path: string, userTurn?: number) {
    setBusyId(`file:${path}`);
    setErr("");
    try {
      await postUndo(undefined, sessionId, { path, userTurn });
      await load();
      onRestored?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="side-panel undo-panel">
      <div className="side-panel-head">
        <IconUndo size={16} />
        <span>{t("navUndo")}</span>
        <div className="side-panel-head-actions">
          {count > 0 ? <span className="undo-count">{count}</span> : null}
          <button type="button" className="icon-btn" title={t("refresh")} onClick={() => void load()}>
            <IconRefresh size={14} />
          </button>
        </div>
      </div>
      <div className="side-panel-body undo-body">
        <p className="undo-hint">{t("ledgerHint")}</p>
        {loading && items.length === 0 ? <div className="muted">{t("loading")}</div> : null}
        {err ? <div className="side-error">{err}</div> : null}
        {items.length === 0 && !loading ? (
          <div className="undo-empty">
            <IconUndo size={22} />
            <p>{t("undoEmpty")}</p>
          </div>
        ) : null}
        <ol className="undo-list">
          {items.map((item, i) => {
            const ts = Number(item.ts || 0);
            const when = ts
              ? new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString(
                  locale === "en" ? "en-US" : "zh-CN",
                  { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
                )
              : "";
            const title = item.user_text || item.label || item.op || item.id;
            const files = fileRows(item);
            const canReplay =
              typeof item.user_turn === "number" && Boolean(item.user_text) && Boolean(onReplay);
            return (
              <li key={item.id || i} className="undo-card">
                <div className="undo-card-top">
                  {when ? <time className="undo-card-when">{when}</time> : null}
                  <div className="undo-card-actions">
                    {canReplay ? (
                      <button
                        type="button"
                        className="undo-card-restore"
                        disabled={Boolean(busyId)}
                        title={t("undoReplay")}
                        onClick={() => onReplay?.(item.user_turn as number, item.user_text || "")}
                      >
                        <IconReplay size={12} />
                        {t("undoReplay")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="undo-card-restore"
                      disabled={Boolean(busyId)}
                      onClick={() => void restore(item.id)}
                    >
                      {t("undoRestoreHere")}
                    </button>
                  </div>
                </div>
                <p className="undo-card-title" title={title}>
                  {title}
                </p>
                {files.length > 0 ? (
                  <ul className="undo-card-files undo-card-file-rows">
                    {files.map((entry) => {
                      const path = entry.path;
                      const who = actorLabel(t, entry.actor, entry.actor_label);
                      return (
                        <li key={path} className="undo-file-row">
                          <div className="undo-file-row-main" title={path}>
                            <span className={`undo-actor ${entry.actor === "sub" ? "sub" : "main"}`}>
                              {who}
                            </span>
                            <span className="undo-file-name">{path.split("/").pop() || path}</span>
                            {entry.why ? (
                              <span className="undo-file-why" title={entry.why}>
                                {entry.why}
                              </span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="undo-file-undo"
                            disabled={Boolean(busyId)}
                            title={t("undoByFile")}
                            onClick={() =>
                              void restoreFile(
                                path,
                                typeof item.user_turn === "number" ? item.user_turn : undefined,
                              )
                            }
                          >
                            {t("undoByFile")}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
        {items.length > 0 ? (
          <button
            type="button"
            className="undo-latest"
            disabled={Boolean(busyId)}
            onClick={() => void restore()}
          >
            {t("undoLatest")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
