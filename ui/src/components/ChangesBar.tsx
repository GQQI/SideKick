import { useCallback, useEffect, useState } from "react";
import { fetchGitReview, fetchGitFileDiff, type GitFileEntry, type GitSnapshot } from "../api";
import { DiffReview } from "./DiffReview";
import { IconChevronRight, IconFiles, IconGit } from "./icons";
import type { MsgKey } from "../i18n";
import { previewFromTexts, type FileDiffPreview } from "../utils/diffPreview";

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  refreshKey?: number;
  sessionId?: string | null;
  onOpenReview?: () => void;
};

export function ChangesBar({ t, refreshKey = 0, sessionId = null, onOpenReview }: Props) {
  const [snap, setSnap] = useState<GitSnapshot | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await fetchGitReview(sessionId));
    } catch {
      setSnap(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const id = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(id);
  }, [load]);

  const files = snap?.files || [];
  const totals = snap?.totals || { files: files.length, added: 0, deleted: 0 };
  if (!snap || totals.files === 0) return null;

  return (
    <div className="changes-bar">
      <button
        type="button"
        className="changes-bar-main"
        onClick={() => onOpenReview?.()}
        title={t("gitReviewHint")}
      >
        {snap.is_repo ? <IconGit size={14} /> : <IconFiles size={14} />}
        <span>{t("gitReviewFiles", String(totals.files))}</span>
        {totals.added > 0 ? <span className="git-stat-add">+{totals.added}</span> : null}
        {totals.deleted > 0 ? <span className="git-stat-del">−{totals.deleted}</span> : null}
      </button>
      <button
        type="button"
        className="changes-bar-toggle"
        aria-label={t("gitReviewList")}
        title={t("gitReviewList")}
        onClick={() => onOpenReview?.()}
      >
        <IconChevronRight size={14} />
      </button>
    </div>
  );
}

function kindLabel(kind: string | undefined, t: Props["t"]) {
  if (kind === "deleted") return t("gitFileDeleted");
  if (kind === "untracked" || kind === "added") return t("gitFileAdded");
  if (kind === "renamed") return t("gitFileRenamed");
  return t("gitFileModified");
}

export function ReviewPanel({
  t,
  refreshKey = 0,
  sessionId = null,
  selectedPath,
  onSelectPath,
}: {
  t: (key: MsgKey, ...args: string[]) => string;
  refreshKey?: number;
  sessionId?: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
}) {
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [diff, setDiff] = useState<FileDiffPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setSnap(await fetchGitReview(sessionId));
    } catch {
      setSnap(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      setErr("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr("");
    void fetchGitFileDiff(selectedPath, sessionId)
      .then((pair) => {
        if (cancelled) return;
        if (pair.binary) {
          setDiff(null);
          setErr(t("reviewBinary"));
          return;
        }
        setDiff(
          previewFromTexts(pair.path, pair.old || "", pair.new || "", {
            isNew: Boolean(pair.is_new) || pair.kind === "added",
            isDeleted: Boolean(pair.is_deleted) || pair.kind === "deleted",
          }),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setDiff(null);
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, refreshKey, sessionId, t]);

  const files = snap?.files || [];
  const totals = snap?.totals || { files: 0, added: 0, deleted: 0 };
  const added = files.filter((f) => f.kind === "added" || f.kind === "untracked");
  const modified = files.filter(
    (f) => f.kind !== "deleted" && f.kind !== "added" && f.kind !== "untracked",
  );
  const deleted = files.filter((f) => f.kind === "deleted");

  function renderList(items: GitFileEntry[]) {
    return (
      <ul className="review-file-list">
        {items.map((f) => {
          const active = f.path === selectedPath;
          return (
            <li key={f.path}>
              <button
                type="button"
                className={`review-file-item${active ? " active" : ""}${f.kind === "deleted" ? " deleted" : ""}`}
                onClick={() => onSelectPath(f.path)}
              >
                <span className={`git-xy git-kind-${f.kind || "modified"}`}>
                  {kindLabel(f.kind, t)}
                </span>
                <span className="git-path" title={f.path}>
                  {f.path}
                </span>
                <span className="git-file-stats">
                  {Number(f.added || 0) > 0 ? (
                    <span className="git-stat-add">+{f.added}</span>
                  ) : null}
                  {Number(f.deleted || 0) > 0 ? (
                    <span className="git-stat-del">−{f.deleted}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="review-panel">
      <div className="review-panel-meta">
        {t("gitReviewFiles", String(totals.files))}
        {totals.added > 0 ? <span className="git-stat-add">+{totals.added}</span> : null}
        {totals.deleted > 0 ? <span className="git-stat-del">−{totals.deleted}</span> : null}
      </div>
      <div className="review-files">
        {files.length === 0 ? <div className="muted">{t("gitClean")}</div> : null}
        {added.length > 0 ? (
          <>
            <div className="review-files-head">{t("gitReviewAdded")}</div>
            {renderList(added)}
          </>
        ) : null}
        {modified.length > 0 ? (
          <>
            <div className="review-files-head">{t("gitReviewModified")}</div>
            {renderList(modified)}
          </>
        ) : null}
        {deleted.length > 0 ? (
          <>
            <div className="review-files-head">{t("gitReviewDeleted")}</div>
            {renderList(deleted)}
          </>
        ) : null}
      </div>
      <div className="review-diff">
        {!selectedPath ? (
          <div className="review-pick">{t("reviewPickFile")}</div>
        ) : err ? (
          <div className="side-error">{err}</div>
        ) : (
          <DiffReview
            diff={diff}
            loading={loading}
            fill
            title={t("reviewFileDiff")}
            newFileLabel={t("diffNewFile")}
            deletedFileLabel={t("diffDeletedFile")}
            truncatedLabel={t("diffTruncated")}
            emptyLabel={t("diffEmpty")}
            alreadyAppliedLabel={t("diffAlreadyApplied")}
            snippetLabel={t("diffSnippet")}
            closeLabel={t("reviewCloseFile")}
            onClose={() => onSelectPath(null)}
          />
        )}
      </div>
    </div>
  );
}
