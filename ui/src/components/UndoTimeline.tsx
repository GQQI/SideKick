import { useCallback, useEffect, useState } from "react";
import { fetchUndo, postUndo, type UndoItem } from "../api";
import { usePrefs } from "../prefs";
import { IconRefresh, IconUndo } from "./icons";

type Props = {
  refreshKey?: number;
  onRestored?: () => void;
};

export function UndoTimeline({ refreshKey = 0, onRestored }: Props) {
  const { t, locale } = usePrefs();
  const [items, setItems] = useState<UndoItem[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetchUndo();
      setItems(res.items || []);
      setCount(res.count || 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function restore(id?: string) {
    setBusyId(id || "*");
    setErr("");
    try {
      await postUndo(id);
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
            const files = item.files || [];
            return (
              <li key={item.id || i} className="undo-card">
                <div className="undo-card-top">
                  {when ? <time className="undo-card-when">{when}</time> : null}
                  <button
                    type="button"
                    className="undo-card-restore"
                    disabled={Boolean(busyId)}
                    onClick={() => void restore(item.id)}
                  >
                    {t("undoRestoreHere")}
                  </button>
                </div>
                <p className="undo-card-title" title={title}>
                  {title}
                </p>
                {files.length > 0 ? (
                  <ul className="undo-card-files">
                    {files.slice(0, 6).map((path) => (
                      <li key={path} className="undo-file-chip" title={path}>
                        {path.split("/").pop() || path}
                      </li>
                    ))}
                    {files.length > 6 ? (
                      <li className="undo-file-chip more">+{files.length - 6}</li>
                    ) : null}
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
