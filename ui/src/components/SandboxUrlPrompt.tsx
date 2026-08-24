import { useEffect, useRef } from "react";
import { usePrefs } from "../prefs";

export type SandboxUrlPromptState = {
  url: string;
  x: number;
  y: number;
};

type Props = {
  prompt: SandboxUrlPromptState | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Floating confirm near a right-clicked / Ctrl+clicked URL. */
export function SandboxUrlPrompt({ prompt, onConfirm, onCancel }: Props) {
  const { t } = usePrefs();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) onCancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [prompt, onCancel]);

  if (!prompt) return null;

  const left = Math.min(Math.max(8, prompt.x), window.innerWidth - 280);
  const top = Math.min(Math.max(8, prompt.y + 10), window.innerHeight - 120);

  return (
    <div
      ref={rootRef}
      className="sandbox-url-prompt"
      style={{ left, top }}
      role="dialog"
      aria-label={t("browserOpenPrompt")}
    >
      <p className="sandbox-url-prompt-q">{t("browserOpenPrompt")}</p>
      <p className="sandbox-url-prompt-url" title={prompt.url}>
        {prompt.url}
      </p>
      <div className="sandbox-url-prompt-actions">
        <button type="button" className="chip" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="button" className="chip action" onClick={onConfirm}>
          {t("browserOpenConfirm")}
        </button>
      </div>
    </div>
  );
}
