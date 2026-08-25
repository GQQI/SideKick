import { useEffect } from "react";
import { buildFileDiff, isFileMutatingTool, toolDiffKey, type FileDiffPreview } from "../utils/diffPreview";
import { writeFilePreview } from "../utils/chatHelpers";
import type { ApprovalPrompt, DetailView } from "../types/chat";

export function useToolDiffs(
  approval: ApprovalPrompt | null,
  detail: DetailView,
  setApprovalDiff: (d: FileDiffPreview | null) => void,
  setApprovalDiffLoading: (v: boolean) => void,
  setDetailDiff: (d: FileDiffPreview | null) => void,
  setDetailDiffLoading: (v: boolean) => void,
) {
  useEffect(() => {
    if (!approval || !isFileMutatingTool(approval.name)) {
      setApprovalDiff(null);
      setApprovalDiffLoading(false);
      return;
    }
    let cancelled = false;
    setApprovalDiff(null);
    setApprovalDiffLoading(true);
    void buildFileDiff(approval.name, approval.args)
      .then((d) => {
        if (!cancelled) setApprovalDiff(d);
      })
      .catch(() => {
        if (!cancelled) setApprovalDiff(null);
      })
      .finally(() => {
        if (!cancelled) setApprovalDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [approval, approval ? toolDiffKey(approval.name, approval.args, approval.callId) : ""]);

  useEffect(() => {
    if (!detail || detail.type !== "tool" || !isFileMutatingTool(detail.tool.name)) {
      setDetailDiff(null);
      setDetailDiffLoading(false);
      return;
    }
    if (detail.tool.status === "streaming") {
      setDetailDiff(null);
      setDetailDiffLoading(false);
      return;
    }
    const tool = detail.tool;
    let cancelled = false;
    setDetailDiff(null);
    setDetailDiffLoading(true);
    void buildFileDiff(tool.name, tool.args)
      .then((d) => {
        if (!cancelled) setDetailDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDetailDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDetailDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    detail?.type === "tool" ? detail.tool.status : "",
    detail?.type === "tool" ? toolDiffKey(detail.tool.name, detail.tool.args, detail.tool.callId) : "",
  ]);

  useEffect(() => {
    if (detail?.type !== "tool" || detail.tool.status !== "streaming") return;
    const el = document.querySelector(".detail-stream") as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    detail?.type === "tool" ? detail.tool.status : "",
    detail?.type === "tool" ? detail.tool.argsRaw : "",
    detail?.type === "tool" ? writeFilePreview(detail.tool.args)?.content?.length : 0,
  ]);
}
