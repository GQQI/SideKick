import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffHunk, DiffLine, FileDiffPreview } from "../utils/diffPreview";
import { mergeAcceptedHunks } from "../utils/diffPreview";
import { IconX } from "./icons";

type Props = {
  diff: FileDiffPreview | null;
  loading?: boolean;
  title?: string;
  newFileLabel?: string;
  truncatedLabel?: string;
  emptyLabel?: string;
  alreadyAppliedLabel?: string;
  snippetLabel?: string;
  compact?: boolean;
  fill?: boolean;
  closeLabel?: string;
  onClose?: () => void;
  /** When true, each change hunk can be accepted or skipped. */
  selectable?: boolean;
  acceptHunkLabel?: string;
  rejectHunkLabel?: string;
  onPatchChange?: (content: string | null, accepted: number, total: number) => void;
};

function DiffLineRow({ line, dual }: { line: DiffLine; dual: boolean }) {
  if (line.kind === "skip") {
    return (
      <div className={`diff-line skip${dual ? " dual-ln" : ""}`}>
        {dual ? (
          <>
            <span className="diff-ln" />
            <span className="diff-ln" />
          </>
        ) : (
          <span className="diff-ln" />
        )}
        <span className="diff-sign" />
        <span className="diff-text">{line.text}</span>
      </div>
    );
  }
  const ln =
    line.kind === "del"
      ? line.oldNo
      : line.kind === "add"
        ? line.newNo
        : (line.newNo ?? line.oldNo);
  return (
    <div className={`diff-line ${line.kind}${dual ? " dual-ln" : ""}`}>
      {dual ? (
        <>
          <span className="diff-ln old">{line.oldNo ?? ""}</span>
          <span className="diff-ln new">{line.newNo ?? ""}</span>
        </>
      ) : (
        <span className="diff-ln">{ln ?? ""}</span>
      )}
      <span className="diff-sign" aria-hidden>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
      </span>
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

function HunkLines({ hunk, dual }: { hunk: DiffHunk; dual: boolean }) {
  return (
    <>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} dual={dual} />
      ))}
    </>
  );
}

/** Unified line diff for write_file / str_replace review. */
export function DiffReview({
  diff,
  loading,
  title = "变更预览",
  newFileLabel = "新建文件",
  truncatedLabel = "已截断显示",
  emptyLabel = "无文本变更",
  alreadyAppliedLabel = "已应用到文件",
  snippetLabel = "片段对比",
  compact,
  fill,
  closeLabel = "关闭",
  onClose,
  selectable,
  acceptHunkLabel = "接受此块",
  onPatchChange,
}: Props) {
  const hunks = diff?.hunks || [];
  const canSelect = Boolean(selectable && diff && !diff.alreadyApplied && hunks.length > 0);
  const dual = !compact;
  const wrapClass = `diff-review${compact ? " compact" : ""}${fill ? " fill" : ""}`;
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const onPatchChangeRef = useRef(onPatchChange);
  onPatchChangeRef.current = onPatchChange;

  useEffect(() => {
    setAccepted(new Set(hunks.map((h) => h.id)));
  }, [diff?.path, hunks.length, diff?.newText]);

  const merged = useMemo(() => {
    if (!canSelect || !diff?.fullLines || !diff.hunkOf) return diff?.newText ?? null;
    return mergeAcceptedHunks(diff.fullLines, diff.hunkOf, accepted);
  }, [canSelect, diff, accepted]);

  useEffect(() => {
    const cb = onPatchChangeRef.current;
    if (!cb) return;
    if (!canSelect) {
      cb(null, 0, 0);
      return;
    }
    cb(merged, accepted.size, hunks.length);
  }, [canSelect, merged, accepted.size, hunks.length]);

  if (loading) {
    return (
      <div className={wrapClass}>
        <div className="diff-review-head">
          <strong>{title}</strong>
        </div>
        <div className="diff-review-empty">…</div>
      </div>
    );
  }
  if (!diff) {
    return (
      <div className={wrapClass}>
        <div className="diff-review-empty">{emptyLabel}</div>
      </div>
    );
  }

  const adds = diff.statAdd ?? diff.lines.filter((l) => l.kind === "add").length;
  const dels = diff.statDel ?? diff.lines.filter((l) => l.kind === "del").length;
  const hasChanges = adds > 0 || dels > 0 || diff.lines.some((l) => l.kind === "add" || l.kind === "del");

  return (
    <div className={wrapClass}>
      <div className="diff-review-head">
        <strong>{title}</strong>
        <span className="diff-review-path" title={diff.path}>
          {diff.path}
        </span>
        <span className="diff-review-meta">
          {diff.isNew ? <span className="diff-badge">{newFileLabel}</span> : null}
          {diff.snippetOnly ? <span className="diff-badge">{snippetLabel}</span> : null}
          {diff.alreadyApplied ? (
            <span className="diff-badge">{alreadyAppliedLabel}</span>
          ) : null}
          {hasChanges || adds > 0 || dels > 0 ? (
            <span className="diff-stats">
              <span className="diff-stat del">−{dels}</span>
              <span className="diff-stat add">+{adds}</span>
            </span>
          ) : (
            <span className="diff-stat muted">{emptyLabel}</span>
          )}
          {canSelect ? (
            <span className="diff-stat muted">
              {accepted.size}/{hunks.length}
            </span>
          ) : null}
          {diff.truncated ? <span className="diff-trunc">{truncatedLabel}</span> : null}
          {onClose ? (
            <button
              type="button"
              className="icon-btn diff-review-close"
              title={closeLabel}
              aria-label={closeLabel}
              onClick={onClose}
            >
              <IconX size={14} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="diff-review-body" role="table" aria-label={title}>
        {!hasChanges ? (
          <div className="diff-review-empty">{emptyLabel}</div>
        ) : canSelect ? (
          hunks.map((hunk) => {
            const on = accepted.has(hunk.id);
            return (
              <div key={hunk.id} className={`diff-hunk${on ? "" : " rejected"}`}>
                <label className="diff-hunk-bar">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      setAccepted((prev) => {
                        const next = new Set(prev);
                        if (next.has(hunk.id)) next.delete(hunk.id);
                        else next.add(hunk.id);
                        return next;
                      });
                    }}
                  />
                  <span>{acceptHunkLabel}</span>
                  <span className="diff-hunk-id">#{hunk.id + 1}</span>
                </label>
                <HunkLines hunk={hunk} dual={dual} />
              </div>
            );
          })
        ) : (
          diff.lines.map((line, i) => <DiffLineRow key={i} line={line} dual={dual} />)
        )}
      </div>
    </div>
  );
}
