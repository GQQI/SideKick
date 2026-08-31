import type { SubNode } from "../types/chat";

/** Prefixes for UI-only cards that must bind onto a real child, not sit beside it. */
export const CANVAS_PLACEHOLDER_KINDS = ["pending", "queued", "restored"] as const;
export type CanvasPlaceholderKind = (typeof CANVAS_PLACEHOLDER_KINDS)[number];

const PLACEHOLDER_KIND_SET = new Set<string>(CANVAS_PLACEHOLDER_KINDS);
const PLACEHOLDER_SCOPE_FALLBACK = "slot";

export function canvasPlaceholderId(
  kind: CanvasPlaceholderKind,
  scope: string,
  index: number,
): string {
  const safeScope = (scope || "").trim() || PLACEHOLDER_SCOPE_FALLBACK;
  return `${kind}:${safeScope}:${index}`;
}

export function isEphemeralCanvasId(id?: string): boolean {
  if (!id) return true;
  const sep = id.indexOf(":");
  if (sep <= 0) return false;
  return PLACEHOLDER_KIND_SET.has(id.slice(0, sep));
}

export function normalizeCanvasGoal(goal?: string): string {
  return (goal || "").replace(/\s+/g, " ").trim();
}

/** True when two labels describe the same worker (full goal vs first-line snapshot). */
export function canvasGoalsMatch(a?: string, b?: string): boolean {
  const rawLeft = (a || "").trim();
  const rawRight = (b || "").trim();
  const left = normalizeCanvasGoal(rawLeft);
  const right = normalizeCanvasGoal(rawRight);
  if (!left || !right) return false;
  if (left === right) return true;
  const firstLine = (value: string) => normalizeCanvasGoal(value.split(/\r?\n/)[0] || "");
  const leftLine = firstLine(rawLeft);
  const rightLine = firstLine(rawRight);
  return Boolean(leftLine) && leftLine === rightLine;
}

function cloneNode(node: SubNode): SubNode {
  return { ...node, children: [...(node.children || [])] };
}

function mergeBound(primary: SubNode, extra: SubNode): SubNode {
  const extraLen = (extra.transcript || []).length;
  const primaryLen = (primary.transcript || []).length;
  return {
    ...extra,
    ...primary,
    id: isEphemeralCanvasId(primary.id) && extra.id ? extra.id : primary.id || extra.id,
    goal: primary.goal || extra.goal,
    role: primary.role || extra.role,
    kind: primary.kind || extra.kind,
    summary: primary.summary || extra.summary,
    children: primary.children?.length ? primary.children : extra.children,
    transcript: extraLen > primaryLen ? extra.transcript : primary.transcript,
  };
}

/**
 * Bind extra cards onto an authoritative slot list.
 * Placeholder extras never create a new root — that is how four delegated
 * workers became five robots (unmatched pending card + real child id).
 */
export function alignCanvasSlots(primary: SubNode[], extras: SubNode[]): SubNode[] {
  if (!primary.length) return extras.map(cloneNode);
  if (!extras.length) return primary.map(cloneNode);

  const slots = primary.map(cloneNode);
  const taken = new Set<number>();

  const take = (predicate: (slot: SubNode) => boolean): number => {
    const idx = slots.findIndex((slot, i) => !taken.has(i) && predicate(slot));
    if (idx >= 0) taken.add(idx);
    return idx;
  };

  const leftover: SubNode[] = [];
  for (const extra of extras) {
    let idx = extra.id ? take((slot) => slot.id === extra.id) : -1;
    if (idx < 0) {
      idx = take((slot) => canvasGoalsMatch(slot.goal, extra.goal));
    }
    if (idx < 0) {
      const extraEph = isEphemeralCanvasId(extra.id);
      idx = take((slot) => extraEph || isEphemeralCanvasId(slot.id));
    }
    if (idx >= 0) {
      slots[idx] = mergeBound(slots[idx], extra);
      continue;
    }
    leftover.push(extra);
  }

  for (const extra of leftover) {
    if (isEphemeralCanvasId(extra.id)) continue;
    if (slots.some((slot) => slot.id === extra.id)) continue;
    slots.push(cloneNode(extra));
  }
  return slots;
}

/** Drop surplus roots so the board cannot outgrow the delegated task list. */
export function limitCanvasRoots(nodes: SubNode[], declared: number): SubNode[] {
  if (!Number.isFinite(declared) || declared <= 0 || nodes.length <= declared) {
    return nodes;
  }
  const preferred = nodes.filter((n) => !isEphemeralCanvasId(n.id));
  const fallback = nodes.filter((n) => isEphemeralCanvasId(n.id));
  const keep = new Set([...preferred, ...fallback].slice(0, declared).map((n) => n.id));
  return nodes.filter((n) => keep.has(n.id));
}
