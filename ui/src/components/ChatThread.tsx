import type { RefObject } from "react";
import { FileTypeIcon, fileCardMeta } from "./FileTypeIcon";
import { IconCheck, IconCube, IconUser } from "./icons";
import { IconRobotCube } from "./IconRobotCube";
import { MarkdownView } from "./MarkdownView";
import { ThinkingBlock } from "./ThinkingBlock";
import { readFileContent } from "../api";
import type { ChatMsg, DetailView } from "../types/chat";
import {
  buildSuggestions,
  fileToDetail,
  greetingKey,
  isSkillInjectMessage,
  writeFilePreview,
} from "../utils/chatHelpers";
import { formatToolSummary } from "../utils/toolSummary";
import { roleIcon } from "../utils/roleIcon";
import type { MsgKey } from "../i18n";

export type ChatThreadProps = {
  t: (key: MsgKey, ...args: string[]) => string;
  messages: ChatMsg[];
  busy: boolean;
  stopping: boolean;
  queuedCount: number;
  compressState: {
    active: boolean;
    message: string;
    attempt: number;
    maxAttempts: number;
    before: number;
    after?: number;
  } | null;
  detail: DetailView;
  editingId: string | null;
  editDraft: string;
  copiedId: string | null;
  threadRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
  onThreadScroll: () => void;
  onSetDetail: (d: DetailView) => void;
  onSend: (text?: string) => void;
  onStopChat: () => void;
  onCopyBubble: (id: string, text: string) => void;
  onStartEditUser: (id: string, content: string) => void;
  onEditDraftChange: (text: string) => void;
  onCancelEdit: () => void;
  onRequestSubmitEdit: (msgId: string) => void;
  onToast: (msg: string) => void;
  onCtrlClickUrl?: (url: string, clientX: number, clientY: number) => void;
};

export function ChatThread({
  t,
  messages,
  busy,
  stopping,
  queuedCount,
  compressState,
  detail,
  editingId,
  editDraft,
  copiedId,
  threadRef,
  bottomRef,
  onThreadScroll,
  onSetDetail,
  onSend,
  onStopChat,
  onCopyBubble,
  onStartEditUser,
  onEditDraftChange,
  onCancelEdit,
  onRequestSubmitEdit,
  onToast,
  onCtrlClickUrl,
}: ChatThreadProps) {
  return (
    <>
      {compressState?.active && (
        <div className="compress-banner">
          <div className="compress-banner-text">
            <strong>
              {compressState.after != null ? t("compressReset") : t("compressResetting")}
            </strong>
            <span>{compressState.message}</span>
          </div>
          <div className="compress-track">
            <div
              className="compress-fill"
              style={{
                width:
                  compressState.after != null
                    ? "100%"
                    : `${Math.min(
                        95,
                        Math.round(
                          (Math.max(1, compressState.attempt) /
                            Math.max(1, compressState.maxAttempts)) *
                            100,
                        ),
                      )}%`,
              }}
            />
          </div>
          <div className="compress-meta">
            {compressState.after != null
              ? `${compressState.before} → ${compressState.after}`
              : `第 ${compressState.attempt || 1}/${compressState.maxAttempts} 轮`}
          </div>
        </div>
      )}
      <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
        {messages.length === 0 && !busy && (
          <div className="empty">
            <div className="empty-hero">
              <span className="empty-hero-icon">
                <IconRobotCube size={40} />
              </span>
              <h3>{t(greetingKey())}</h3>
              <p>{t("tagline")}</p>
            </div>
            <div className="suggestions">
              {buildSuggestions(t).map((s) => (
                <button key={s.text} type="button" onClick={() => void onSend(s.text)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === "tool" && m.tool) {
            const tool = m.tool;
            const active = detail?.type === "tool" && detail.tool.callId === tool.callId;
            const writePrev =
              tool.name === "write_file" ? writeFilePreview(tool.args) : null;
            if (
              writePrev?.path &&
              (tool.status === "done" || tool.status === "running" || tool.status === "streaming")
            ) {
              const meta = fileCardMeta(writePrev.path);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`file-ref-card${active ? " active" : ""}${tool.status !== "done" ? " pending" : ""}`}
                  onClick={() => onSetDetail({ type: "tool", tool })}
                  title={writePrev.path}
                >
                  <FileTypeIcon name={meta.name} />
                  <span className="file-ref-body">
                    <strong>{meta.name}</strong>
                    <span>{meta.dir || writePrev.path}</span>
                  </span>
                  {tool.status === "done" ? (
                    <span className="file-ref-status ok">
                      <IconCheck size={14} />
                    </span>
                  ) : (
                    <span className="file-ref-status">…</span>
                  )}
                </button>
              );
            }
            const label =
              tool.summary ||
              formatToolSummary(tool.name || "", tool.args) ||
              tool.name ||
              "tool";
            return (
              <button
                key={m.id}
                type="button"
                className={`tool-chip ${tool.status}${active ? " active" : ""}`}
                onClick={() => onSetDetail({ type: "tool", tool })}
                title={label}
              >
                <span className="tool-chip-mark">
                  {tool.status === "pending"
                    ? "?"
                    : tool.status === "streaming"
                      ? "…"
                      : tool.status === "running"
                        ? "…"
                        : tool.status === "error"
                          ? "!"
                          : "…"}
                </span>
                <span className="tool-chip-body">
                  <span className="tool-chip-name">{tool.name || "tool"}</span>
                  <span className="tool-chip-summary">{label}</span>
                </span>
                {tool.status === "pending" && <span className="tool-chip-hint">等待确认</span>}
                {tool.status === "streaming" && <span className="tool-chip-hint">生成中</span>}
              </button>
            );
          }
          if (m.role === "subagent" && m.subagent) {
            const s = m.subagent;
            const active = detail?.type === "subagent" && detail.subagent.id === s.id;
            return (
              <button
                key={m.id}
                type="button"
                className={`subagent-card ${s.status}${active ? " active" : ""}`}
                onClick={() => onSetDetail({ type: "subagent", subagent: s })}
              >
                <div className="subagent-card-head">
                  <span className="subagent-card-badge">
                    <span className="subagent-card-icon">{roleIcon(s.role || "")}</span>
                    {t("subtaskLabel")}
                    {s.role ? ` · ${s.role}` : ""}
                  </span>
                  <span className="subagent-card-status">
                    {s.status === "running"
                      ? t("subtaskRunning")
                      : s.status === "error"
                        ? t("toolStatusError")
                        : t("toolStatusDone")}
                  </span>
                </div>
                <div className="subagent-card-goal">{s.goal}</div>
                {s.status === "running" && s.activity && (
                  <div className="subagent-card-activity">{s.activity}</div>
                )}
                {s.summary && s.status !== "running" && (
                  <pre className="subagent-card-summary">{s.summary}</pre>
                )}
              </button>
            );
          }
          return (
            <article
              key={m.id}
              className={`bubble ${m.role}${m.streaming ? " streaming" : ""}${
                editingId === m.id ? " editing" : ""
              }${m.role === "user" && isSkillInjectMessage(m.content) ? " skill-inject" : ""}`}
            >
              <div className="bubble-head">
                <div className="role">
                  <span
                    className={`role-avatar ${
                      m.role === "user" && isSkillInjectMessage(m.content) ? "system" : m.role
                    }`}
                  >
                    {m.role === "user" && isSkillInjectMessage(m.content) ? (
                      <IconCube size={18} />
                    ) : m.role === "user" ? (
                      <IconUser size={18} />
                    ) : m.role === "system" ? (
                      <IconCube size={18} />
                    ) : (
                      <IconRobotCube size={22} />
                    )}
                  </span>
                  <span className="role-label">
                    {m.role === "user" && isSkillInjectMessage(m.content)
                      ? t("skillInjected")
                      : m.role === "user"
                        ? t("you")
                        : m.role === "system"
                          ? t("command")
                          : t("assistant")}
                    {m.streaming
                      ? m.reasoningStreaming
                        ? ` · ${t("thinking")}`
                        : ` · ${t("outputting")}`
                      : ""}
                  </span>
                </div>
                {!m.streaming &&
                  (m.role === "user" || m.role === "assistant" || m.role === "system") && (
                    <div className="bubble-actions">
                      <button
                        type="button"
                        className="bubble-action"
                        title={t("copy")}
                        onClick={() => void onCopyBubble(m.id, m.content)}
                      >
                        {copiedId === m.id ? t("copied") : t("copy")}
                      </button>
                      {m.role === "user" &&
                        !isSkillInjectMessage(m.content) &&
                        editingId !== m.id && (
                          <button
                            type="button"
                            className="bubble-action"
                            title={t("edit")}
                            disabled={busy}
                            onClick={() => onStartEditUser(m.id, m.content)}
                          >
                            {t("edit")}
                          </button>
                        )}
                    </div>
                  )}
              </div>
              {m.role === "assistant" && (m.reasoning || m.reasoningStreaming) && (
                <ThinkingBlock
                  content={m.reasoning || ""}
                  streaming={Boolean(m.reasoningStreaming)}
                />
              )}
              {editingId === m.id && m.role === "user" ? (
                <div className="bubble-edit">
                  <textarea
                    value={editDraft}
                    autoFocus
                    rows={Math.min(12, Math.max(3, editDraft.split("\n").length + 1))}
                    onChange={(e) => onEditDraftChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        onCancelEdit();
                      }
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        onRequestSubmitEdit(m.id);
                      }
                    }}
                  />
                  <div className="bubble-edit-actions">
                    <button type="button" className="bubble-edit-btn cancel" onClick={onCancelEdit}>
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      className="bubble-edit-btn primary"
                      disabled={!editDraft.trim() || busy}
                      onClick={() => onRequestSubmitEdit(m.id)}
                    >
                      {t("resend")}
                    </button>
                  </div>
                  <p className="bubble-edit-hint">{t("editHint")}</p>
                </div>
              ) : m.role === "assistant" ||
                m.role === "system" ||
                (m.role === "user" && isSkillInjectMessage(m.content)) ? (
                m.content ? (
                  <MarkdownView
                    content={m.content}
                    streaming={m.streaming && !m.reasoningStreaming}
                    onCtrlClickUrl={onCtrlClickUrl}
                  />
                ) : m.streaming && !m.reasoningStreaming ? (
                  <div className="plain muted">…</div>
                ) : null
              ) : (
                <div className="user-bubble-body">
                  {m.attachments && m.attachments.length > 0 && (
                    <ul className="bubble-attach-list">
                      {m.attachments.map((a) => (
                        <li key={`${a.path}:${a.name}`}>
                          <button
                            type="button"
                            className="bubble-attach-chip"
                            title={a.path}
                            onClick={() => {
                              void readFileContent(a.path)
                                .then((file) => onSetDetail(fileToDetail(file)))
                                .catch((err) =>
                                  onToast(err instanceof Error ? err.message : String(err)),
                                );
                            }}
                          >
                            <FileTypeIcon name={a.name} />
                            <span className="attach-chip-text">
                              <strong>{a.name}</strong>
                              <em>{a.path}</em>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.content ? <div className="plain">{m.content}</div> : null}
                </div>
              )}
            </article>
          );
        })}
        {busy && !messages.some((m) => m.streaming) && (
          <div className="typing-row">
            <span className="typing">
              {stopping
                ? t("stoppingNow")
                : queuedCount
                  ? t("busyWorkingQueued", String(queuedCount))
                  : t("busyWorking")}
            </span>
            <button type="button" className="stop-btn" onClick={() => void onStopChat()}>
              {t("stop")}
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
