import { readFileContent } from "../api";

export type DiffLineKind = "ctx" | "add" | "del" | "skip";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
};

export type FileDiffPreview = {
  path: string;
  oldText: string;
  newText: string;
  isNew: boolean;
  /** True when preview is only the old/new snippet (file not used). */
  snippetOnly?: boolean;
  /** True when file already matches the intended result. */
  alreadyApplied?: boolean;
  /**
   * Header stats aligned with tool chip (str_replace: −old_lines/+new_lines).
   * Prefer these over LCS add/del counts for display.
   */
  statDel?: number;
  statAdd?: number;
  lines: DiffLine[];
  truncated?: boolean;
  fullLines?: DiffLine[];
  hunks?: DiffHunk[];
  hunkOf?: number[];
};

const MAX_DIFF_CHARS = 120_000;
const MAX_RENDER_LINES = 800;
const HUNK_CONTEXT = 3;

/** Myers-ish LCS line diff → unified rows (ctx / add / del). */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  let a = oldText.replace(/\r\n/g, "\n").split("\n");
  let b = newText.replace(/\r\n/g, "\n").split("\n");
  // Empty string → one empty line looks like a phantom change; normalize
  if (a.length === 1 && a[0] === "" && b.length === 1 && b[0] === "") return [];
  const MAX_LINES = 1500;
  if (a.length > MAX_LINES) a = a.slice(0, MAX_LINES).concat(["…"]);
  if (b.length > MAX_LINES) b = b.slice(0, MAX_LINES).concat(["…"]);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i], oldNo: oldNo++ });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], newNo: newNo++ });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i++], oldNo: oldNo++ });
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j++], newNo: newNo++ });
  }
  return out;
}

/** Keep changed lines plus nearby context; insert skip markers for gaps. */
export function collapseUnchanged(lines: DiffLine[], context = HUNK_CONTEXT): DiffLine[] {
  if (lines.length <= 40) return lines;
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "add" || lines[i].kind === "del") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        keep.add(k);
      }
    }
  }
  if (keep.size === 0) return lines.slice(0, Math.min(lines.length, 40));
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep.has(i)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep.has(j)) j++;
    const skipped = j - i;
    if (skipped > 0) {
      out.push({ kind: "skip", text: `··· ${skipped} unchanged lines ···` });
    }
    i = j;
  }
  return out;
}

function nlines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

function truncateText(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_DIFF_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_DIFF_CHARS) + "\n…", truncated: true };
}

function applyStrReplace(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (!oldString) return text;
  if (!text.includes(oldString)) return text;
  if (replaceAll) return text.split(oldString).join(newString);
  return text.replace(oldString, newString);
}

function argString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return "";
}

export async function buildFileDiff(
  tool: string,
  args: unknown,
): Promise<FileDiffPreview | null> {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const path = argString(obj, "path");
  if (!path) return null;
  if (tool !== "write_file" && tool !== "str_replace") return null;

  let fileText = "";
  let fileMissing = false;
  try {
    const file = await readFileContent(path);
    fileText = typeof file.content === "string" ? file.content : "";
  } catch {
    fileMissing = true;
    fileText = "";
  }

  let oldText = fileText;
  let newText = fileText;
  let isNew = fileMissing;
  let snippetOnly = false;
  let alreadyApplied = false;
  let statDel: number | undefined;
  let statAdd: number | undefined;

  if (tool === "write_file") {
    newText = argString(obj, "content");
    if (fileMissing || !fileText) {
      isNew = true;
      oldText = "";
    } else if (fileText === newText) {
      alreadyApplied = true;
    }
    // Chip uses content line count for new files; for edits use LCS below as fallback
    if (isNew || !fileText) {
      statDel = 0;
      statAdd = nlines(newText);
    }
  } else if (tool === "str_replace") {
    const oldStr = argString(obj, "old_string", "oldString");
    const newStr = argString(obj, "new_string", "newString");
    const replaceAll = Boolean(obj.replace_all ?? obj.replaceAll);

    if (!oldStr && !newStr) return null;

    // Always align header/chip: −old_string lines / +new_string lines
    statDel = nlines(oldStr);
    statAdd = nlines(newStr);

    if (fileMissing) {
      oldText = oldStr;
      newText = newStr;
      snippetOnly = true;
      isNew = true;
    } else if (oldStr && fileText.includes(oldStr)) {
      // Pending: show focused snippet diff (same strings as the chip), not whole-file LCS
      oldText = oldStr;
      newText = newStr;
      snippetOnly = true;
      // Still verify apply would work
      const applied = applyStrReplace(fileText, oldStr, newStr, replaceAll);
      if (applied === fileText && oldStr === newStr) {
        /* no-op */
      }
    } else {
      // Already applied (or mismatch): snippet-only, never reverse whole file
      oldText = oldStr;
      newText = newStr;
      snippetOnly = true;
      alreadyApplied = Boolean(newStr && fileText.includes(newStr));
    }
  }

  const oldT = truncateText(oldText);
  const newT = truncateText(newText);
  // For str_replace chips (−N/+M 行), show the replace block as full del then add
  // so body counts match the header (LCS would hide shared lines as ctx).
  let lines =
    tool === "str_replace"
      ? (() => {
          const a = oldT.text.replace(/\r\n/g, "\n").split("\n");
          const b = newT.text.replace(/\r\n/g, "\n").split("\n");
          const out: DiffLine[] = [];
          let oldNo = 1;
          let newNo = 1;
          for (const line of a) {
            if (a.length === 1 && a[0] === "" && !oldT.text) continue;
            out.push({ kind: "del", text: line, oldNo: oldNo++ });
          }
          for (const line of b) {
            if (b.length === 1 && b[0] === "" && !newT.text) continue;
            out.push({ kind: "add", text: line, newNo: newNo++ });
          }
          return out;
        })()
      : collapseUnchanged(computeLineDiff(oldT.text, newT.text));
  let truncated = oldT.truncated || newT.truncated;
  if (lines.length > MAX_RENDER_LINES) {
    lines = lines.slice(0, MAX_RENDER_LINES);
    truncated = true;
  }

  // Fallback stats from LCS when not set (e.g. write_file overwrite)
  if (statDel == null || statAdd == null) {
    statAdd = lines.filter((l) => l.kind === "add").length;
    statDel = lines.filter((l) => l.kind === "del").length;
  }

  const fullLines = tool === "write_file" ? computeLineDiff(oldT.text, newT.text) : lines;
  const grouped = tool === "write_file" ? groupDiffHunks(fullLines) : { hunks: [], hunkOf: [] };

  return {
    path,
    oldText,
    newText,
    isNew,
    snippetOnly,
    alreadyApplied,
    statDel,
    statAdd,
    lines,
    truncated,
    fullLines,
    hunks: grouped.hunks,
    hunkOf: grouped.hunkOf,
  };
}

export function isFileMutatingTool(name: string): boolean {
  return name === "write_file" || name === "str_replace";
}

export type DiffHunk = {
  id: number;
  lines: DiffLine[];
};

/** Assign each full-diff line to a hunk id (−1 = context-only between hunks). */
export function groupDiffHunks(lines: DiffLine[]): { hunks: DiffHunk[]; hunkOf: number[] } {
  const hunkOf = lines.map(() => -1);
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "add" && lines[i].kind !== "del") {
      i++;
      continue;
    }
    const id = hunks.length;
    let start = i;
    let end = i;
    while (end < lines.length && (lines[end].kind === "add" || lines[end].kind === "del")) {
      end++;
    }
    const ctxStart = Math.max(0, start - HUNK_CONTEXT);
    let ctxEnd = end;
    let extra = 0;
    while (ctxEnd < lines.length && extra < HUNK_CONTEXT && lines[ctxEnd].kind === "ctx") {
      ctxEnd++;
      extra++;
    }
    for (let k = start; k < end; k++) hunkOf[k] = id;
    hunks.push({ id, lines: lines.slice(ctxStart, ctxEnd) });
    i = end;
  }
  return { hunks, hunkOf };
}

/** Rebuild file text from a full line-diff, keeping only accepted hunks. */
export function mergeAcceptedHunks(
  lines: DiffLine[],
  hunkOf: number[],
  accepted: Set<number>,
): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hid = hunkOf[i] ?? -1;
    if (line.kind === "ctx" || line.kind === "skip") {
      if (line.kind === "ctx") out.push(line.text);
      continue;
    }
    const keepNew = hid < 0 || accepted.has(hid);
    if (line.kind === "add" && keepNew) out.push(line.text);
    if (line.kind === "del" && !keepNew) out.push(line.text);
  }
  return out.join("\n");
}

/** Stable key so React effects refresh when switching tools / args. */
export function toolDiffKey(name: string, args: unknown, callId?: string): string {
  let argsKey = "";
  try {
    argsKey = JSON.stringify(args ?? null);
  } catch {
    argsKey = String(args);
  }
  if (argsKey.length > 2000) argsKey = argsKey.slice(0, 2000);
  return `${callId || ""}|${name}|${argsKey}`;
}

export function previewFromTexts(
  path: string,
  oldText: string,
  newText: string,
  opts?: { isNew?: boolean },
): FileDiffPreview {
  const oldT = truncateText(oldText || "");
  const newT = truncateText(newText || "");
  let lines = collapseUnchanged(computeLineDiff(oldT.text, newT.text));
  let truncated = oldT.truncated || newT.truncated;
  if (lines.length > MAX_RENDER_LINES) {
    lines = lines.slice(0, MAX_RENDER_LINES);
    truncated = true;
  }
  const fullLines = computeLineDiff(oldT.text, newT.text);
  const grouped = groupDiffHunks(fullLines);
  return {
    path,
    oldText: oldT.text,
    newText: newT.text,
    isNew: Boolean(opts?.isNew),
    statAdd: lines.filter((l) => l.kind === "add").length,
    statDel: lines.filter((l) => l.kind === "del").length,
    lines,
    truncated,
    fullLines,
    hunks: grouped.hunks,
    hunkOf: grouped.hunkOf,
  };
}
