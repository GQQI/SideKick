import { useState } from "react";
import { usePrefs } from "../prefs";
import { MarkdownView } from "./MarkdownView";

type Props = {
  content: string;
  streaming?: boolean;
};

/** Collapsed-by-default thinking / reasoning block. */
export function ThinkingBlock({ content, streaming }: Props) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  if (!content && !streaming) return null;
  return (
    <div className={`thinking-block${streaming ? " streaming" : ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
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
