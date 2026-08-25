import { FileHighlightView, FileTextEditor, countTextLines } from "./FileHighlightView";
import { DiffReview } from "./DiffReview";
import { ReviewPanel } from "./ChangesBar";
import { LinkifiedText } from "./LinkifiedText";
import { MarkdownView } from "./MarkdownView";
import { ThinkingBlock } from "./ThinkingBlock";
import { IconX } from "./icons";
import { isFileMutatingTool, type FileDiffPreview } from "../utils/diffPreview";
import { formatArgs, formatBytes, writeFilePreview } from "../utils/chatHelpers";
import { sanitizeBrowserUrl } from "../browser/urlDetect";
import type { DetailView } from "../types/chat";
import type { Locale, MsgKey } from "../i18n";

type UrlPick = { url: string; x: number; y: number };

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  locale: Locale;
  detail: NonNullable<DetailView>;
  detailWidth: number;
  detailDiff: FileDiffPreview | null;
  detailDiffLoading: boolean;
  fsRefresh: number;
  sessionId: string | null;
  onResizeStart: () => void;
  onClose: () => void;
  onChange: (next: NonNullable<DetailView>) => void;
  onSaveFile: () => void;
  onPickUrl: (pick: UrlPick) => void;
};

function toolStatusLabel(
  t: Props["t"],
  status: string,
): string {
  if (status === "streaming") return t("toolStatusStreaming");
  if (status === "running" || status === "pending") return t("toolStatusRunning");
  if (status === "error") return t("toolStatusError");
  if (status === "done") return t("toolStatusDone");
  return status;
}

export function DetailPanel({
  t,
  locale,
  detail,
  detailWidth,
  detailDiff,
  detailDiffLoading,
  fsRefresh,
  sessionId,
  onResizeStart,
  onClose,
  onChange,
  onSaveFile,
  onPickUrl,
}: Props) {
  const pickUrl = (url: string, x: number, y: number) => {
    onPickUrl({ url: sanitizeBrowserUrl(url) || url, x, y });
  };

  const title =
    detail.type === "tool"
      ? `${t("detailTool")} · ${detail.tool.name}`
      : detail.type === "subagent"
        ? `${t("detailSubagent")} · ${detail.subagent.role || "leaf"}`
        : detail.type === "changes"
          ? t("gitReviewList")
          : detail.path;

  return (
    <>
      <div
        className="sidebar-resizer detail-resizer"
        onMouseDown={onResizeStart}
        title="拖拽调整预览宽度"
      />
      <aside className="detail-panel" style={{ width: detailWidth }}>
        <div className="detail-head">
          <h3>{title}</h3>
          <div className="detail-actions">
            {detail.type === "file" &&
              detail.kind === "text" &&
              detail.editable &&
              !detail.forceEdit &&
              !detail.dirty && (
                <button
                  type="button"
                  className="mini"
                  onClick={() => onChange({ ...detail, forceEdit: true })}
                >
                  {locale === "en" ? "Edit" : "编辑"}
                </button>
              )}
            {detail.type === "file" && detail.editable && (
              <button type="button" className="mini" disabled={!detail.dirty} onClick={onSaveFile}>
                {locale === "en" ? "Save" : "保存"}
              </button>
            )}
            {detail.type === "file" && detail.rawUrl && detail.kind !== "text" && (
              <a className="mini linkish" href={detail.rawUrl} target="_blank" rel="noreferrer">
                {locale === "en" ? "Open / Download" : "打开/下载"}
              </a>
            )}
            <button
              type="button"
              className="icon-btn detail-close"
              title={t("detailClose")}
              aria-label={t("detailClose")}
              onClick={onClose}
            >
              <IconX size={16} />
            </button>
          </div>
        </div>
        {detail.type === "tool" ? (
          <ToolDetail
            t={t}
            locale={locale}
            detail={detail}
            detailDiff={detailDiff}
            detailDiffLoading={detailDiffLoading}
            onPickUrl={pickUrl}
          />
        ) : detail.type === "subagent" ? (
          <SubagentDetail t={t} detail={detail} onPickUrl={pickUrl} />
        ) : detail.type === "changes" ? (
          <ReviewPanel
            t={t}
            refreshKey={fsRefresh}
            sessionId={sessionId}
            selectedPath={detail.selectedPath}
            onSelectPath={(path) => onChange({ type: "changes", selectedPath: path })}
          />
        ) : (
          <FileDetail detail={detail} onChange={onChange} />
        )}
      </aside>
    </>
  );
}

function ToolDetail({
  t,
  locale,
  detail,
  detailDiff,
  detailDiffLoading,
  onPickUrl,
}: {
  t: Props["t"];
  locale: Locale;
  detail: Extract<NonNullable<DetailView>, { type: "tool" }>;
  detailDiff: FileDiffPreview | null;
  detailDiffLoading: boolean;
  onPickUrl: (url: string, x: number, y: number) => void;
}) {
  const mutating = Boolean(detail.tool.name && isFileMutatingTool(detail.tool.name));
  const preview = mutating && detail.tool.status === "streaming" ? writeFilePreview(detail.tool.args) : null;

  return (
    <div className="detail-body">
      <div className="detail-meta">
        {t("detailStatus")}
        {toolStatusLabel(t, detail.tool.status)}
      </div>
      {mutating ? (
        detail.tool.status === "streaming" ? (
          <>
            <div className="detail-meta">
              {t("toolStatusStreaming")}
              {preview?.path ? ` · ${preview.path}` : ""}
            </div>
            <h4>{preview ? (locale === "en" ? "Content" : "内容") : t("detailArgs")}</h4>
            <pre className="code-fence detail-stream">
              {preview ? preview.content : detail.tool.argsRaw || formatArgs(detail.tool.args)}
            </pre>
          </>
        ) : (
          <>
            <h4>{t("diffPreview")}</h4>
            <DiffReview
              diff={detailDiff}
              loading={detailDiffLoading}
              title={t("diffPreview")}
              newFileLabel={t("diffNewFile")}
              truncatedLabel={t("diffTruncated")}
              emptyLabel={t("diffEmpty")}
              alreadyAppliedLabel={t("diffAlreadyApplied")}
              snippetLabel={t("diffSnippet")}
            />
          </>
        )
      ) : (
        <>
          <h4>{t("detailArgs")}</h4>
          <pre className="code-fence">
            {detail.tool.argsRaw && detail.tool.status === "streaming"
              ? detail.tool.argsRaw
              : formatArgs(detail.tool.args)}
          </pre>
        </>
      )}
      {detail.tool.status !== "streaming" || !mutating ? (
        <>
          <h4>{t("detailOutput")}</h4>
          <LinkifiedText
            className="code-fence"
            text={
              detail.tool.result ||
              (detail.tool.status === "streaming"
                ? t("toolArgsStreaming")
                : detail.tool.status === "running" || detail.tool.status === "pending"
                  ? t("toolRunning")
                  : t("toolNoOutput"))
            }
            onCtrlClickUrl={onPickUrl}
          />
        </>
      ) : null}
    </div>
  );
}

function SubagentDetail({
  t,
  detail,
  onPickUrl,
}: {
  t: Props["t"];
  detail: Extract<NonNullable<DetailView>, { type: "subagent" }>;
  onPickUrl: (url: string, x: number, y: number) => void;
}) {
  return (
    <div className="detail-body subagent-detail">
      <div className="detail-meta">
        {detail.subagent.status === "running"
          ? t("toolStatusRunning")
          : detail.subagent.status === "error"
            ? t("toolStatusFailStop")
            : t("subagentDone")}
        {detail.subagent.activity ? ` · ${detail.subagent.activity}` : ""}
      </div>
      <p className="subagent-detail-goal">{detail.subagent.goal}</p>
      <div className="subagent-detail-thread">
        {(detail.subagent.transcript || []).length === 0 && (
          <p className="hint">{t("subagentWaiting")}</p>
        )}
        {(detail.subagent.transcript || []).map((item) => {
          if (item.kind === "assistant") {
            return (
              <article
                key={item.id}
                className={`bubble assistant${item.streaming ? " streaming" : ""}`}
              >
                <div className="role">
                  {t("subagentLabel")}
                  {item.streaming
                    ? item.reasoningStreaming
                      ? ` · ${t("thinking")}`
                      : ` · ${t("outputting")}`
                    : ""}
                </div>
                {(item.reasoning || item.reasoningStreaming) && (
                  <ThinkingBlock
                    content={item.reasoning || ""}
                    streaming={Boolean(item.reasoningStreaming)}
                  />
                )}
                {item.text ? (
                  <MarkdownView
                    content={item.text}
                    streaming={item.streaming && !item.reasoningStreaming}
                    onCtrlClickUrl={onPickUrl}
                  />
                ) : null}
              </article>
            );
          }
          const tool = item.tool;
          return (
            <div key={item.id} className={`tool-chip ${tool.status}`} title={tool.summary}>
              <span className="tool-chip-mark">
                {tool.status === "pending"
                  ? "?"
                  : tool.status === "streaming" || tool.status === "running"
                    ? "…"
                    : tool.status === "error"
                      ? "!"
                      : "…"}
              </span>
              <span className="tool-chip-body">
                <span className="tool-chip-name">{tool.name}</span>
                <span className="tool-chip-summary">{tool.summary}</span>
              </span>
              {tool.result && (
                <LinkifiedText
                  className="subagent-tool-result"
                  text={tool.result.slice(0, 2000)}
                  onCtrlClickUrl={onPickUrl}
                />
              )}
            </div>
          );
        })}
      </div>
      {detail.subagent.summary && detail.subagent.status !== "running" && (
        <>
          <h4>{t("subagentFinalSummary")}</h4>
          <pre className="code-fence">{detail.subagent.summary}</pre>
        </>
      )}
    </div>
  );
}

function FileDetail({
  detail,
  onChange,
}: {
  detail: Extract<NonNullable<DetailView>, { type: "file" }>;
  onChange: (next: NonNullable<DetailView>) => void;
}) {
  return (
    <div className="detail-body file-preview">
      <div className="detail-meta">
        {detail.kind}
        {detail.mime ? ` · ${detail.mime}` : ""}
        {detail.size != null ? ` · ${formatBytes(detail.size)}` : ""}
        {detail.kind === "text" ? ` · ${countTextLines(detail.content || "")} lines` : ""}
      </div>
      {detail.kind === "image" && detail.rawUrl && (
        <div className="media-frame">
          <img src={detail.rawUrl} alt={detail.path} />
        </div>
      )}
      {detail.kind === "pdf" && detail.rawUrl && (
        <iframe className="pdf-frame" title={detail.path} src={detail.rawUrl} />
      )}
      {detail.kind === "audio" && detail.rawUrl && (
        <audio className="media-player" controls src={detail.rawUrl} />
      )}
      {detail.kind === "video" && detail.rawUrl && (
        <video className="media-player" controls src={detail.rawUrl} />
      )}
      {detail.kind === "document" && (
        <div className="office-preview">
          <p className="hint">
            {detail.message || "文本预览（非完整排版）"}。需要原文件请点「打开/下载」。
          </p>
          <pre className="code-fence office-text">{detail.preview || "（无文字内容）"}</pre>
        </div>
      )}
      {detail.kind === "unsupported" && (
        <div className="unsupported-preview">
          <p className="hint unsupported-msg">{detail.message || "暂不支持预览此文件"}</p>
          {detail.rawUrl && <p className="hint">可使用「打开/下载」在系统中查看原文件。</p>}
        </div>
      )}
      {detail.kind === "text" && !detail.forceEdit && !detail.dirty ? (
        <FileHighlightView
          content={detail.content}
          query={detail.highlightQuery || ""}
          focusLine={detail.focusLine}
        />
      ) : detail.kind === "text" ? (
        <FileTextEditor
          value={detail.content}
          readOnly={!detail.editable}
          onChange={(content) => onChange({ ...detail, content, dirty: true })}
        />
      ) : null}
    </div>
  );
}
