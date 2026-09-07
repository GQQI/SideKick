import { useEffect, useState } from "react";
import { usePrefs } from "../prefs";
import { MarkdownView } from "./MarkdownView";

type Props = {
  content: string;
  streaming?: boolean;
};

/** Thinking / reasoning block — stays open after streaming so it does not
 *  "vanish" into a collapsed header the moment the turn finishes. */
export function ThinkingBlock({ content, streaming }: Props) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(true);
  const [userCollapsed, setUserCollapsed] = useState(false);
  useEffect(() => {
    if (streaming && !userCollapsed) setOpen(true);
  }, [streaming, userCollapsed]);
  if (!content && !streaming) return null;
  return (
    <div className={`thinking-block${streaming ? " streaming" : ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            setUserCollapsed(!next);
            return next;
          });
        }}
        aria-expanded={open}
      >
        <span className="thinking-mark">{streaming ? "…" : "◇"}</span>
        <span className="thinking-label">
          {streaming ? t("thinking") : open ? t("thinkingProcess") : t("thinkingCollapsed")}
        </span>
        <span className="thinking-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="thinking-body">
          <MarkdownView content={content || "…"} streaming={streaming} />
        </div>
      )}
    </div>
  );
}
