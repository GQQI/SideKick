import type { MsgKey } from "../i18n";

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  onClose: () => void;
  onChatOnly: () => void;
  onWithFiles: () => void;
};

export function EditRestoreModal({ t, onClose, onChatOnly, onWithFiles }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal edit-restore-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("editRestoreTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t("editRestoreTitle")}</h2>
          <button type="button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">{t("editRestoreBody")}</p>
          <div className="edit-restore-actions">
            <button type="button" className="bubble-edit-btn cancel" onClick={onClose}>
              {t("cancel")}
            </button>
            <button type="button" className="bubble-edit-btn" onClick={onChatOnly}>
              {t("editRestoreChatOnly")}
            </button>
            <button type="button" className="bubble-edit-btn primary" onClick={onWithFiles}>
              {t("editRestoreWithFiles")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
