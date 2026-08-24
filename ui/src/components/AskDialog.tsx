import { MarkdownView } from "./MarkdownView";

export type AskOption = { key: string; label: string };

type Props = {
  question: string;
  options: AskOption[];
  allowCustom: boolean;
  customLabel: string;
  choice: string;
  otherText: string;
  submitting: boolean;
  titleLabel: string;
  dialogLabel: string;
  submitLabel: string;
  otherPlaceholder: string;
  onPick: (key: string) => void;
  onOtherChange: (text: string) => void;
  onOtherFocus: () => void;
  onSubmitCustom: () => void;
};

/** Inline clarification dialog with scrollable markdown body and sticky options. */
export function AskDialog({
  question,
  options,
  allowCustom,
  customLabel,
  choice,
  otherText,
  submitting,
  titleLabel,
  dialogLabel,
  submitLabel,
  otherPlaceholder,
  onPick,
  onOtherChange,
  onOtherFocus,
  onSubmitCustom,
}: Props) {
  return (
    <div className="inline-ask" role="dialog" aria-label={dialogLabel}>
      <div className="inline-ask-top">
        <div className="inline-ask-title">{titleLabel}</div>
        <div className="inline-ask-question">
          <MarkdownView content={question || ""} />
        </div>
      </div>
      <div className="inline-ask-footer">
        <div className="inline-ask-options">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`ask-option${choice === o.key ? " active" : ""}`}
              onClick={() => onPick(o.key)}
              disabled={submitting}
            >
              <span className="ask-key">{o.key}</span>
              <span className="ask-label">{o.label}</span>
            </button>
          ))}
        </div>
        {allowCustom ? (
          <div className="inline-ask-other">
            <div className="inline-ask-other-label">{customLabel}</div>
            <div className="inline-ask-other-form">
              <textarea
                className="inline-ask-textarea"
                rows={2}
                placeholder={otherPlaceholder}
                value={otherText}
                onChange={(e) => onOtherChange(e.target.value)}
                onFocus={onOtherFocus}
                disabled={submitting}
              />
              <button
                type="button"
                className="approval-btn allow"
                disabled={submitting}
                onClick={onSubmitCustom}
              >
                {submitLabel}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
