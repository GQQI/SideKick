import type { RuntimeEvent } from "../../api";
import type { ChatMsg, DetailView, ToolCard } from "../../types/chat";
import { formatToolSummary } from "../../utils/toolSummary";
import { softParseToolArgs, uid, writeFilePreview } from "../../utils/chatHelpers";

export type ToolUpsertCtx = {
  sealStreamBubble: () => void;
  findToolMsg: (opts: {
    callId?: string;
    name?: string;
    statuses?: ToolCard["status"][];
  }) => ChatMsg | undefined;
  updateMsg: (id: string, patch: Partial<ChatMsg>) => void;
  syncToolPanel: (tool: ToolCard, prevCallId?: string) => void;
  appendMsg: (msg: ChatMsg) => void;
  setDetail: React.Dispatch<React.SetStateAction<DetailView>>;
  transcriptRef: React.MutableRefObject<ChatMsg[]>;
};

/** Auto-open / refresh write_file preview only when it won't steal focus. */
function revealWriteFileDetail(
  setDetail: React.Dispatch<React.SetStateAction<DetailView>>,
  tool: ToolCard,
) {
  setDetail((d) => {
    if (d == null) return { type: "tool", tool };
    if (d.type !== "tool") return d;
    const same =
      d.tool.id === tool.id ||
      (Boolean(tool.callId) && d.tool.callId === tool.callId);
    return same ? { type: "tool", tool } : d;
  });
}

export function upsertToolStart(ev: RuntimeEvent, ctx: ToolUpsertCtx) {
  ctx.sealStreamBubble();
  const callId = String(ev.data.call_id || uid());
  const name = String(ev.data.name || "tool");
  const pending = Boolean(ev.data.needs_approval);
  const existing =
    ctx.findToolMsg({ callId }) ||
    ctx.findToolMsg({
      name,
      statuses: ["streaming", "pending"],
    });
  if (existing?.tool) {
    const prevCallId = existing.tool.callId;
    const tool: ToolCard = {
      ...existing.tool,
      callId,
      status: pending ? "pending" : "running",
      args: ev.data.args ?? existing.tool.args,
      name: name || existing.tool.name,
      summary:
        String(ev.data.summary || "") ||
        formatToolSummary(name, ev.data.args ?? existing.tool.args),
    };
    ctx.updateMsg(existing.id, { tool });
    ctx.syncToolPanel(tool, prevCallId);
    if (name === "write_file") {
      const preview = writeFilePreview(tool.args);
      if (preview) revealWriteFileDetail(ctx.setDetail, tool);
    }
    return tool;
  }
  const tool: ToolCard = {
    id: uid(),
    callId,
    name,
    args: ev.data.args,
    status: pending ? "pending" : "running",
    summary:
      String(ev.data.summary || "") || formatToolSummary(name, ev.data.args),
  };
  ctx.appendMsg({ id: tool.id, role: "tool", content: "", tool });
  ctx.syncToolPanel(tool);
  if (name === "write_file") revealWriteFileDetail(ctx.setDetail, tool);
  return tool;
}

export function upsertToolDelta(ev: RuntimeEvent, ctx: ToolUpsertCtx) {
  const index = Number(ev.data.index ?? 0);
  const streamKey = `stream_${index}`;
  const realId = String(ev.data.id || "");
  const name = String(ev.data.name || "");
  const argsRaw = String(ev.data.arguments || "");
  const args = softParseToolArgs(argsRaw);
  const callId = realId || streamKey;

  const existing =
    ctx.findToolMsg({ callId }) ||
    ctx.findToolMsg({ callId: streamKey }) ||
    (realId ? ctx.findToolMsg({ callId: realId }) : undefined) ||
    ctx.transcriptRef.current.find(
      (m) =>
        m.role === "tool" &&
        m.tool?.status === "streaming" &&
        Number(
          (m.tool.args as { _streamIndex?: number } | undefined)?._streamIndex,
        ) === index,
    );

  // Seal the assistant bubble only once when tool streaming *starts*.
  // Sealing on every tool_call_delta breaks models that interleave content
  // tokens with argument deltas — each content token became its own bubble.
  if (!existing?.tool) {
    ctx.sealStreamBubble();
  }

  const summary = formatToolSummary(name || existing?.tool?.name || "", args);
  if (existing?.tool) {
    const prevCallId = existing.tool.callId;
    const tool: ToolCard = {
      ...existing.tool,
      callId,
      name: name || existing.tool.name,
      args: { ...args, _streamIndex: index },
      argsRaw,
      status: "streaming",
      summary,
    };
    ctx.updateMsg(existing.id, { tool });
    ctx.syncToolPanel(tool, prevCallId);
    if ((name || existing.tool.name) === "write_file") {
      revealWriteFileDetail(ctx.setDetail, tool);
    }
    return;
  }

  const tool: ToolCard = {
    id: uid(),
    callId,
    name: name || "tool",
    args: { ...args, _streamIndex: index },
    argsRaw,
    status: "streaming",
    summary,
  };
  ctx.appendMsg({ id: tool.id, role: "tool", content: "", tool });
  if (name === "write_file" || !name) {
    revealWriteFileDetail(ctx.setDetail, tool);
  }
}

export function upsertToolEnd(ev: RuntimeEvent, ctx: ToolUpsertCtx) {
  const callId = String(ev.data.call_id || "");
  const name = String(ev.data.name || "tool");
  const result = String(ev.data.result ?? ev.data.preview ?? "");
  const ok = ev.data.ok !== false && !result.startsWith("ERROR");
  const hit =
    ctx.findToolMsg({ callId }) ||
    ctx.findToolMsg({
      name,
      statuses: ["running", "streaming", "pending"],
    });
  if (hit?.tool) {
    const prevCallId = hit.tool.callId;
    const tool: ToolCard = {
      ...hit.tool,
      callId: callId || hit.tool.callId,
      name,
      args: ev.data.args ?? hit.tool.args,
      result,
      status: ok ? "done" : "error",
    };
    ctx.updateMsg(hit.id, { tool });
    ctx.syncToolPanel(tool, prevCallId);
    return;
  }
  const tool: ToolCard = {
    id: uid(),
    callId: callId || uid(),
    name,
    args: ev.data.args,
    result,
    status: ok ? "done" : "error",
  };
  ctx.appendMsg({ id: tool.id, role: "tool", content: "", tool });
  ctx.syncToolPanel(tool);
}
