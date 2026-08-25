import type { PendingConfirm } from "../types/chat";

type Props = {
  pending: PendingConfirm;
  onCancel: () => void;
  onError: (message: string) => void;
};

export function ConfirmBanner({ pending, onCancel, onError }: Props) {
  return (
    <div className="confirm-banner" role="dialog" aria-label="确认操作">
      <div className="confirm-banner-text">
        <strong>{pending.title}</strong>
        {pending.detail && <span>{pending.detail}</span>}
      </div>
      <div className="confirm-banner-actions">
        <button type="button" className="fe-inline-btn cancel" title="取消" onClick={onCancel}>
          ✕
        </button>
        <button
          type="button"
          className="fe-inline-btn ok"
          title={pending.confirmLabel || "确认"}
          onClick={() => {
            const action = pending;
            onCancel();
            void Promise.resolve(action.run()).catch((e) =>
              onError(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
