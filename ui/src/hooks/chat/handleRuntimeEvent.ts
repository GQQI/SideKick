import type { RuntimeEvent } from "../../api";
import type { PlanTask, PlanTaskStatus } from "../../components/TaskPlanPanel";
import type { ActivePlan } from "../../components/TaskPlanPanel";
import {
  FS_MUTATING_TOOLS,
  type ApprovalPrompt,
  type AskOption,
  type AskPrompt,
  type ChatMsg,
  type DetailView,
  type LiveLine,
  type SubNode,
  type SubTool,
  type SubTranscriptItem,
  type ToolCard,
} from "../../types/chat";
import type { PlanConfirmState, ShapeContract } from "../../types/plan";
import { formatToolSummary } from "../../utils/toolSummary";
import { isFileMutatingTool } from "../../utils/diffPreview";
import { findSubNode, softParseToolArgs, uid } from "../../utils/chatHelpers";
import type { MsgKey } from "../../i18n";
import { upsertToolDelta, upsertToolEnd, upsertToolStart, type ToolUpsertCtx } from "./toolUpserts";

export type RuntimeEventHandlerCtx = ToolUpsertCtx & {
  t: (key: MsgKey, ...args: string[]) => string;
  locale: string;
  sessionId: string | null;
  sessionIdRef: React.MutableRefObject<string | null>;
  setPlanConfirm: React.Dispatch<React.SetStateAction<PlanConfirmState | null>>;
  setActivePlan: React.Dispatch<React.SetStateAction<ActivePlan | null>>;
  planPendingRef: React.MutableRefObject<boolean>;
  executingPlanIdRef: React.MutableRefObject<string | null>;
  patchSubagent: (childId: string, fn: (s: SubNode) => SubNode) => void;
  sealSubassistant: (transcript: SubTranscriptItem[]) => SubTranscriptItem[];
  setLive: React.Dispatch<React.SetStateAction<LiveLine[]>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setCtx: React.Dispatch<React.SetStateAction<{ tokens: number; limit: number }>>;
  setCompressState: React.Dispatch<
    React.SetStateAction<{
      active: boolean;
      message: string;
      attempt: number;
      maxAttempts: number;
      before: number;
      after?: number;
    } | null>
  >;
  appendStreamChunk: (chunk: string, reset?: boolean, discard?: boolean) => void;
  appendReasoningChunk: (chunk: string, reset?: boolean) => void;
  setApproval: React.Dispatch<React.SetStateAction<ApprovalPrompt | null>>;
  findToolMsg: (opts: {
    callId?: string;
    name?: string;
    statuses?: ToolCard["status"][];
  }) => ChatMsg | undefined;
  updateMsg: (id: string, patch: Partial<ChatMsg>) => void;
  syncToolPanel: (tool: ToolCard, prevCallId?: string) => void;
  setDetail: React.Dispatch<React.SetStateAction<DetailView>>;
  stripDuplicateAskBubble: (question: string) => void;
  askPendingRef: React.MutableRefObject<boolean>;
  setAskChoice: React.Dispatch<React.SetStateAction<string>>;
  setAskOtherText: React.Dispatch<React.SetStateAction<string>>;
  setAskPrompt: React.Dispatch<React.SetStateAction<AskPrompt | null>>;
  setFsRefresh: React.Dispatch<React.SetStateAction<number>>;
  setSubs: React.Dispatch<React.SetStateAction<SubNode[]>>;
  appendMsg: (msg: ChatMsg) => void;
};

function parsePlanTasks(raw: unknown): PlanTask[] {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    try {
      raw = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: PlanTask[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "string") {
      const title = item.trim();
      if (!title) return;
      out.push({ id: `task_${i}`, title, status: "pending" });
      return;
    }
    const o = item as Record<string, unknown>;
    const title = String(o.title || o.name || "").trim();
    if (!title) return;
    out.push({
      id: String(o.id || `task_${i}`),
      title,
      detail: String(o.detail || o.description || "").trim() || undefined,
      status: String(o.status || "pending") as PlanTaskStatus,
    });
  });
  return out;
}

function planIsExecuting(plan: ActivePlan | null): boolean {
  if (!plan || plan.awaitingConfirm) return false;
  return plan.mode === "agent" && plan.tasks.length > 0;
}

function applyPlanStep(
  prev: ActivePlan | null,
  data: Record<string, unknown>,
  fallbackTitle: string,
): ActivePlan {
  const snapshot = parsePlanTasks(data.tasks);
  const taskId = String(data.task_id || "");
  const status = String(data.status || "running") as PlanTaskStatus;
  const index = Number(data.index);
  const title = String(data.title || "");
  const planId = String(data.plan_id || prev?.planId || "");
  const summary = String(data.summary || prev?.summary || title || fallbackTitle);

  let tasks: PlanTask[] = snapshot.length ? snapshot.map((t) => ({ ...t })) : [...(prev?.tasks || [])];

  const markHit = (list: PlanTask[]): PlanTask[] => {
    let hitIdx = taskId ? list.findIndex((t) => t.id === taskId) : -1;
    if (hitIdx < 0 && Number.isFinite(index)) hitIdx = index;
    if (hitIdx >= 0 && hitIdx < list.length) {
      const next = [...list];
      next[hitIdx] = {
        ...next[hitIdx],
        status,
        title: title || next[hitIdx].title,
      };
      return next;
    }
    const row: PlanTask = {
      id: taskId || `task_${Number.isFinite(index) ? index : list.length}`,
      title: title || `步骤 ${(Number.isFinite(index) ? index : list.length) + 1}`,
      status,
    };
    if (Number.isFinite(index) && index >= list.length) {
      const padded = [...list];
      while (padded.length < index) {
        padded.push({
          id: `task_${padded.length}`,
          title: `步骤 ${padded.length + 1}`,
          status: "pending",
        });
      }
      padded.push(row);
      return padded;
    }
    return [...list, row];
  };

  tasks = markHit(tasks);

  if (status === "running" && Number.isFinite(index) && index > 0) {
    tasks = tasks.map((t, i) =>
      i < index && (t.status === "pending" || t.status === "running")
        ? { ...t, status: "done" as const }
        : t,
    );
  }

  return {
    planId,
    summary,
    mode: "agent",
    awaitingConfirm: false,
    shapeContract: prev?.shapeContract || null,
    tasks,
  };
}

function parseShapeContract(raw: unknown): ShapeContract | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: ShapeContract = {};
  for (const key of [
    "reuse",
    "create_only_if",
    "config_placement",
    "control_flow",
    "why_not_smaller",
    "verify_command",
  ] as const) {
    const v = String(o[key] || "").trim();
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function handleRuntimeEvent(ev: RuntimeEvent, ctx: RuntimeEventHandlerCtx): void {
  const type = ev.type;

  if (type === "plan_created") {
    const tasks = parsePlanTasks(ev.data.tasks);
    const summary = String(ev.data.summary || "");
    const planId = String(ev.data.plan_id || "");
    const shapeContract = parseShapeContract(ev.data.shape_contract);
    const awaiting =
      Boolean(ev.data.awaiting_confirm) || ev.data.mode === "plan";
    if (awaiting) {
      if (ctx.executingPlanIdRef.current && ctx.executingPlanIdRef.current === planId) {
        return;
      }
      const planSid = String(
        ev.data.session_id || ctx.sessionIdRef.current || ctx.sessionId || "",
      );
      ctx.planPendingRef.current = true;
      ctx.setPlanConfirm({
        planId,
        sessionId: planSid,
        summary,
        tasks,
        shapeContract,
      });
      ctx.setActivePlan((prev) => (planIsExecuting(prev) ? prev : null));
    } else if (tasks.length) {
      ctx.executingPlanIdRef.current = planId || ctx.executingPlanIdRef.current;
      ctx.setActivePlan((prev) => {
        const byId = new Map((prev?.tasks || []).map((t) => [t.id, t.status]));
        return {
          planId,
          summary: summary || prev?.summary || "",
          mode: "agent",
          awaitingConfirm: false,
          shapeContract: shapeContract || prev?.shapeContract || null,
          tasks: tasks.map((t, i) => ({
            ...t,
            status:
              byId.get(t.id) ??
              prev?.tasks[i]?.status ??
              t.status ??
              "pending",
          })),
        };
      });
    }
  }
  if (type === "plan_confirm_request") {
    const planId = String(ev.data.plan_id || "");
    if (ctx.executingPlanIdRef.current && ctx.executingPlanIdRef.current === planId) {
      return;
    }
    const tasks = parsePlanTasks(ev.data.tasks);
    const summary = String(ev.data.summary || "");
    const shapeContract = parseShapeContract(ev.data.shape_contract);
    const planSid = String(
      ev.data.session_id || ctx.sessionIdRef.current || ctx.sessionId || "",
    );
    ctx.planPendingRef.current = true;
    ctx.setPlanConfirm({
      planId,
      sessionId: planSid,
      summary,
      tasks,
      shapeContract,
    });
    ctx.setActivePlan((prev) => (planIsExecuting(prev) ? prev : null));
  }
  if (type === "plan_confirm_resolved") {
    ctx.planPendingRef.current = false;
    ctx.setPlanConfirm((cur) =>
      cur && cur.planId === String(ev.data.plan_id || "") ? null : cur,
    );
    if (ev.data.approved) {
      ctx.executingPlanIdRef.current = String(ev.data.plan_id || "") || ctx.executingPlanIdRef.current;
    } else {
      ctx.executingPlanIdRef.current = null;
      ctx.setActivePlan(null);
    }
  }
  if (type === "plan_step") {
    const planId = String(ev.data.plan_id || "");
    if (planId) ctx.executingPlanIdRef.current = planId;
    ctx.setPlanConfirm(null);
    ctx.setActivePlan((prev) => applyPlanStep(prev, ev.data, ctx.t("taskPlanTitle")));
  }
  if (type === "plan_done") {
    ctx.planPendingRef.current = false;
    ctx.executingPlanIdRef.current = null;
    ctx.setPlanConfirm(null);
    ctx.setActivePlan(null);
  }

  // Subagent events share the bus — accumulate into subagent transcript.
  // Gate events (approval / ask / nested spawn) must still reach the main UI;
  // otherwise a leaf that needs confirmation stays "running" forever.
  const childGateTypes = new Set([
    "approval_request",
    "approval_resolved",
    "ask_request",
    "ask_resolved",
    "plan_created",
    "plan_confirm_request",
    "plan_confirm_resolved",
    "plan_step",
    "plan_done",
    "subagent_start",
    "subagent_end",
    "cancelled",
    "error",
    "final",
  ]);
  if (ev.parent_id) {
    const childId = String(ev.agent_id || "");
    if (childId && type === "assistant_delta") {
      const reset = Boolean(ev.data.reset);
      const chunk = String(ev.data.chunk ?? ev.data.text ?? "");
      ctx.patchSubagent(childId, (s) => {
        let tr = [...(s.transcript || [])];
        if (reset) tr = ctx.sealSubassistant(tr);
        // Prefer the last assistant item even if a tool card sits after it
        // (models may interleave content + tool_call deltas).
        let streamIdx = -1;
        for (let i = tr.length - 1; i >= 0; i--) {
          const item = tr[i];
          if (item.kind === "tool") continue;
          if (item.kind === "assistant") {
            streamIdx = i;
            break;
          }
          break;
        }
        if (!reset && streamIdx >= 0) {
          const last = tr[streamIdx];
          if (last.kind === "assistant") {
            tr[streamIdx] = {
              ...last,
              text: last.text + chunk,
              streaming: true,
            };
          }
        } else if (chunk || reset) {
          tr = ctx.sealSubassistant(tr);
          tr.push({
            id: uid(),
            kind: "assistant",
            text: chunk,
            streaming: true,
          });
        }
        return { ...s, transcript: tr, activity: "生成中…" };
      });
    } else if (childId && type === "assistant_reasoning_delta") {
      const chunk = String(ev.data.chunk ?? "");
      ctx.patchSubagent(childId, (s) => {
        let tr = [...(s.transcript || [])];
        const last = tr[tr.length - 1];
        if (last?.kind === "assistant" && last.streaming) {
          tr[tr.length - 1] = {
            ...last,
            reasoning: (last.reasoning || "") + chunk,
            reasoningStreaming: !last.text.trim(),
          };
        } else {
          tr = ctx.sealSubassistant(tr);
          tr.push({
            id: uid(),
            kind: "assistant",
            text: "",
            reasoning: chunk,
            streaming: true,
            reasoningStreaming: true,
          });
        }
        return { ...s, transcript: tr, activity: ctx.t("thinkingActivity") };
      });
    } else if (childId && type === "tool_call_delta") {
      const callId = String(ev.data.id || `stream_${ev.data.index ?? 0}`);
      const name = String(ev.data.name || "");
      const argsRaw = String(ev.data.arguments || "");
      const args = softParseToolArgs(argsRaw);
      const summary = formatToolSummary(name, args);
      ctx.patchSubagent(childId, (s) => {
        let tr = [...(s.transcript || [])];
        const idx = tr.findIndex(
          (x) =>
            x.kind === "tool" &&
            (x.tool.callId === callId ||
              (x.tool.status === "streaming" && x.tool.name === name)),
        );
        // Seal assistant only when the first tool delta of this call arrives
        if (idx < 0) tr = ctx.sealSubassistant(tr);
        const tool: SubTool = {
          id: idx >= 0 && tr[idx].kind === "tool" ? tr[idx].tool.id : uid(),
          callId,
          name: name || (idx >= 0 && tr[idx].kind === "tool" ? tr[idx].tool.name : "tool"),
          summary,
          status: "streaming",
          args,
        };
        if (idx >= 0) tr[idx] = { id: tool.id, kind: "tool", tool };
        else tr.push({ id: tool.id, kind: "tool", tool });
        return { ...s, transcript: tr, activity: summary };
      });
    } else if (childId && type === "tool_start") {
      const callId = String(ev.data.call_id || uid());
      const name = String(ev.data.name || "tool");
      const summary =
        String(ev.data.summary || "") ||
        formatToolSummary(name, ev.data.args);
      ctx.patchSubagent(childId, (s) => {
        let tr = ctx.sealSubassistant(s.transcript || []);
        const idx = tr.findIndex(
          (x) =>
            x.kind === "tool" &&
            (x.tool.callId === callId ||
              (x.tool.status === "streaming" &&
                (x.tool.name === name || !x.tool.name))),
        );
        const tool: SubTool = {
          id: idx >= 0 && tr[idx].kind === "tool" ? tr[idx].tool.id : uid(),
          callId,
          name,
          summary,
          status: "running",
          args: ev.data.args,
        };
        if (idx >= 0) tr[idx] = { id: tool.id, kind: "tool", tool };
        else tr.push({ id: tool.id, kind: "tool", tool });
        return { ...s, transcript: tr, activity: summary };
      });
    } else if (childId && type === "tool_end") {
      const callId = String(ev.data.call_id || "");
      const name = String(ev.data.name || "tool");
      const ok = Boolean(ev.data.ok !== false);
      const result = String(ev.data.result ?? ev.data.preview ?? "");
      const summary =
        String(ev.data.summary || "") ||
        formatToolSummary(name, ev.data.args);
      ctx.patchSubagent(childId, (s) => {
        const tr = [...(s.transcript || [])];
        const idx = tr.findIndex(
          (x) =>
            x.kind === "tool" &&
            (x.tool.callId === callId ||
              (x.tool.name === name &&
                (x.tool.status === "running" || x.tool.status === "streaming"))),
        );
        const tool: SubTool = {
          id: idx >= 0 && tr[idx].kind === "tool" ? tr[idx].tool.id : uid(),
          callId: callId || uid(),
          name,
          summary,
          status: ok ? "done" : "error",
          args: ev.data.args,
          result,
        };
        if (idx >= 0) tr[idx] = { id: tool.id, kind: "tool", tool };
        else tr.push({ id: tool.id, kind: "tool", tool });
        return {
          ...s,
          transcript: tr,
          activity: ok ? `${name} 完成` : `${name} 失败`,
        };
      });
      if (FS_MUTATING_TOOLS.has(name)) {
        ctx.setFsRefresh((n) => n + 1);
      }
    }
    if (!childGateTypes.has(type)) {
      const label =
        (ev.data.message as string) ||
        `${type}${ev.data.name ? " " + ev.data.name : ""}`;
      ctx.setLive((prev) =>
        [...prev, { id: uid(), text: `[子] ${label}`, kind: type }].slice(-120),
      );
      return;
    }
  }

  if (type === "session") {
    const sid = String(ev.data.session_id || "");
    if (sid) {
      ctx.sessionIdRef.current = sid;
      ctx.setSessionId(sid);
    }
  }

  if (type === "context_usage" || type === "llm_start") {
    const budget = (ev.data.budget || {}) as Record<string, unknown>;
    ctx.setCtx((c) => {
      const tokens = Number(ev.data.tokens ?? budget.tokens_est ?? c.tokens);
      const limit = Number(ev.data.limit ?? c.limit);
      return {
        tokens: Number.isFinite(tokens) ? tokens : c.tokens,
        limit: Number.isFinite(limit) && limit > 0 ? limit : c.limit,
      };
    });
  }

  if (type === "compress_start" || type === "compress_progress") {
    ctx.setCompressState({
      active: true,
      message: String(ev.data.message || "正在快速压缩上下文…"),
      attempt: Number(ev.data.attempt || 0),
      maxAttempts: Number(ev.data.max_attempts || 3),
      before: Number(ev.data.before || ev.data.tokens || 0),
    });
    ctx.setCtx((c) => ({
      tokens: Number(ev.data.tokens ?? c.tokens),
      limit: Number(ev.data.limit ?? c.limit),
    }));
  }

  if (type === "compress") {
    const after = Number(ev.data.after || 0);
    const before = Number(ev.data.before || 0);
    ctx.setCompressState({
      active: true,
      message: String(ev.data.message || `上下文已重置 ${before}→${after}`),
      attempt: Number((ev.data.meta as { attempts?: number } | undefined)?.attempts || 0),
      maxAttempts: Number(ev.data.max_attempts || 3),
      before,
      after,
    });
    ctx.setCtx((c) => ({
      tokens: after || Number(ev.data.tokens || 0),
      limit: Number(ev.data.limit || c.limit),
    }));
    window.setTimeout(() => ctx.setCompressState(null), 2200);
  }

  if (type === "assistant_delta") {
    const reset = Boolean(ev.data.reset);
    const discard = Boolean(ev.data.discard);
    const chunk = String(ev.data.chunk ?? ev.data.text ?? "");
    ctx.appendStreamChunk(chunk, reset, discard);
  }

  if (type === "assistant_reasoning_delta") {
    const chunk = String(ev.data.chunk ?? ev.data.text ?? "");
    ctx.appendReasoningChunk(chunk, false);
  }

  if (type === "tool_call_delta") {
    upsertToolDelta(ev, ctx);
  }

  if (type === "approval_request") {
    ctx.setApproval({
      approvalId: String(ev.data.approval_id || ""),
      callId: String(ev.data.call_id || ""),
      name: String(ev.data.name || "tool"),
      args: ev.data.args,
      summary: String(ev.data.summary || ev.data.message || ""),
    });
    const callId = String(ev.data.call_id || "");
    const hit =
      ctx.findToolMsg({ callId }) ||
      ctx.findToolMsg({
        name: String(ev.data.name || ""),
        statuses: ["streaming", "running", "pending"],
      });
    if (hit?.tool) {
      const prevCallId = hit.tool.callId;
      const tool: ToolCard = {
        ...hit.tool,
        callId: callId || hit.tool.callId,
        status: "pending",
        args: ev.data.args ?? hit.tool.args,
        summary: String(ev.data.summary || ""),
      };
      ctx.updateMsg(hit.id, { tool });
      ctx.syncToolPanel(tool, prevCallId);
      // Don't steal the detail panel if the user is inspecting another tool/file.
      if (isFileMutatingTool(tool.name)) {
        ctx.setDetail((d) => {
          if (d == null) return { type: "tool", tool };
          if (d.type !== "tool") return d;
          const same =
            d.tool.id === tool.id ||
            (Boolean(tool.callId) && d.tool.callId === tool.callId);
          return same ? { type: "tool", tool } : d;
        });
      }
    }
  }
  if (type === "approval_resolved") {
    ctx.setApproval((cur) =>
      cur && cur.approvalId === String(ev.data.approval_id || "") ? null : cur,
    );
  }

  if (type === "ask_request") {
    const rawOpts = Array.isArray(ev.data.options) ? ev.data.options : [];
    const options: AskOption[] = rawOpts
      .map((o) => {
        if (!o || typeof o !== "object") return null;
        const rec = o as Record<string, unknown>;
        const key = String(rec.key || "").trim();
        const label = String(rec.label || "").trim();
        if (!key || !label) return null;
        return { key, label };
      })
      .filter((o): o is AskOption => Boolean(o));
    const question = String(ev.data.question || "");
    const allowCustom = ev.data.allow_custom !== false;
    const customLabel = String(
      ev.data.custom_label || (ctx.locale === "en" ? "Other (type your answer)" : "其他（请补充）"),
    );
    ctx.stripDuplicateAskBubble(question);
    const askSid = String(
      ev.data.session_id || ctx.sessionIdRef.current || ctx.sessionId || "",
    );
    ctx.askPendingRef.current = true;
    ctx.setAskChoice("");
    ctx.setAskOtherText("");
    ctx.setAskPrompt({
      askId: String(ev.data.ask_id || ""),
      callId: String(ev.data.call_id || ""),
      sessionId: askSid,
      question,
      options,
      allowCustom,
      customLabel,
      summary: String(ev.data.summary || ev.data.message || ""),
    });
  }
  if (type === "ask_resolved") {
    ctx.askPendingRef.current = false;
    ctx.setAskPrompt((cur) =>
      cur && cur.askId === String(ev.data.ask_id || "") ? null : cur,
    );
    ctx.setAskChoice("");
    ctx.setAskOtherText("");
  }

  if (type === "tool_start") {
    upsertToolStart(ev, ctx);
  }
  if (type === "tool_end") {
    upsertToolEnd(ev, ctx);
    const toolName = String(ev.data.name || "");
    if (FS_MUTATING_TOOLS.has(toolName)) {
      ctx.setFsRefresh((n) => n + 1);
    }
  }

  if (type === "subagent_start") {
    const party = String(ev.data.party || "");
    const label = String(ev.data.label || party || "").trim();
    const replay = Boolean(ev.data.replay);
    const goal = label || String(ev.data.goal || "");
    const replayItems = Array.isArray(ev.data.transcript)
      ? (ev.data.transcript as Array<Record<string, unknown>>)
      : [];
    const transcript: SubTranscriptItem[] = replayItems.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      if (item.kind === "tool") {
        const name = String(item.name || "tool");
        return [
          {
            id: uid(),
            kind: "tool" as const,
            tool: {
              id: uid(),
              callId: String(item.call_id || uid()),
              name,
              summary: name,
              status: "done" as const,
              result: String(item.result || ""),
            },
          },
        ];
      }
      const text = String(item.text || item.content || "").trim();
      return text ? [{ id: uid(), kind: "assistant" as const, text }] : [];
    });
    const node: SubNode = {
      id: String(ev.data.child_id),
      goal,
      status: "running",
      role: party || String(ev.data.role || "leaf"),
      activity: String(ev.data.activity || "启动中…"),
      transcript,
    };
    const spawnerId = String(ev.agent_id || "");
    const nestedParent =
      ev.parent_id && spawnerId
        ? ctx.transcriptRef.current.find(
            (m) =>
              m.role === "subagent" &&
              m.subagent &&
              findSubNode(m.subagent, spawnerId),
          )
        : undefined;
    if (nestedParent?.subagent) {
      ctx.patchSubagent(spawnerId, (s) => {
        const kids = [...(s.children || [])];
        const idx = kids.findIndex((k) => k.id === node.id);
        if (idx >= 0) {
          const prev = kids[idx];
          kids[idx] = {
            ...prev,
            ...node,
            children: prev.children,
            transcript:
              prev.transcript?.length && !node.transcript.length
                ? prev.transcript
                : node.transcript.length
                  ? node.transcript
                  : prev.transcript,
          };
        } else {
          kids.push(node);
        }
        return {
          ...s,
          children: kids,
          activity: s.status === "running" ? `子任务 · ${node.goal}` : s.activity,
        };
      });
    } else {
    const keys = [party, label, node.goal, String(ev.data.goal || "")].filter(Boolean);
    const existing = ctx.transcriptRef.current.find((m) => {
      if (m.role !== "subagent" || !m.subagent) return false;
      const s = m.subagent;
      if (s.id === node.id) return true;
      return keys.some(
        (k) =>
          s.role === k ||
          s.goal === k ||
          s.goal.startsWith(`${k} —`) ||
          s.goal.startsWith(`You are ${k}`) ||
          String(ev.data.goal || "").startsWith(`You are ${s.role}`),
      );
    });
    if (existing?.subagent) {
      const merged: SubNode = {
        ...existing.subagent,
        ...node,
        id: node.id,
        children: existing.subagent.children,
        transcript:
          existing.subagent.transcript?.length && !transcript.length
            ? existing.subagent.transcript
            : transcript.length
              ? transcript
              : existing.subagent.transcript,
      };
      ctx.updateMsg(existing.id, {
        subagent: merged,
        content: merged.summary || merged.goal,
      });
      ctx.setSubs((prev) => {
        const without = prev.filter((s) => s.id !== existing.subagent?.id && s.id !== merged.id);
        return [...without, merged];
      });
      ctx.setDetail((d) =>
        d?.type === "subagent" &&
        (d.subagent.id === existing.subagent?.id || d.subagent.id === merged.id)
          ? { type: "subagent", subagent: merged }
          : d,
      );
    } else {
      ctx.setSubs((prev) => (prev.some((s) => s.id === node.id) ? prev : [...prev, node]));
      ctx.appendMsg({
        id: uid(),
        role: "subagent",
        content: node.goal,
        subagent: node,
      });
      if (!replay) ctx.setDetail({ type: "subagent", subagent: node });
    }
    }
  }
  if (type === "subagent_end") {
    const childId = String(ev.data.child_id);
    const summary = String(ev.data.summary || "");
    const cancelled = Boolean(ev.data.cancelled);
    const ok = !cancelled && !summary.startsWith("ERROR");
    ctx.patchSubagent(childId, (s) => ({
      ...s,
      status: ok ? "done" : "error",
      summary: cancelled ? summary || "（已停止）" : summary,
      activity: undefined,
      transcript: ctx.sealSubassistant(s.transcript || []),
    }));
  }

  const label =
    (ev.data.message as string) ||
    `${type}${ev.data.name ? " " + ev.data.name : ""}`;
  ctx.setLive((prev) =>
    [...prev, { id: uid(), text: label, kind: type }].slice(-120),
  );
}
