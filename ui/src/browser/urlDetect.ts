/** Detect / sanitize http(s) URLs in chat text and browser navigation. */

/**
 * ASCII URL body only — stops before markdown (*_~`), CJK, and whitespace.
 */
export const URL_RE =
  /https?:\/\/[A-Za-z0-9][-A-Za-z0-9._~:/?#\[\]@!$&'()+,;=%]*/gi;

export function normalizeDetectedUrl(raw: string): string {
  let u = (raw || "").trim();
  try {
    u = decodeURIComponent(u);
  } catch {
    /* keep */
  }
  u = u.replace(/[*),.;:!?，。；！？*_~`]+$/g, "");
  return u;
}

/** Display form for localhost:port (no forced trailing slash). */
export function displayHttpUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return href;
    if (u.pathname === "/" && !u.search && !u.hash) {
      return `${u.protocol}//${u.host}`;
    }
    return u.toString();
  } catch {
    return href;
  }
}

const PREVIEW_FILE_RE = /\.(html?|pdf)([?#]|$)/i;

/**
 * Workspace-relative, file://, or same-origin path to HTML/PDF — not a remote link.
 */
export function isLocalPreviewTarget(raw: string): boolean {
  const t = String(raw || "").trim();
  if (!t || t === "about:blank") return false;
  if (/^file:/i.test(t)) return PREVIEW_FILE_RE.test(t);
  if (/^https?:/i.test(t)) {
    try {
      const u = new URL(t);
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      return Boolean(origin) && u.origin === origin && PREVIEW_FILE_RE.test(u.pathname);
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  return PREVIEW_FILE_RE.test(t);
}

/** @deprecated use isLocalPreviewTarget */
export function isLocalHtmlTarget(raw: string): boolean {
  return isLocalPreviewTarget(raw);
}

/** Workspace-relative path (or file://) to pass to the preview server. */
export function localPreviewPath(raw: string): string {
  const t = String(raw || "").trim();
  if (!t) return "";
  if (/^file:/i.test(t)) return t;
  if (/^https?:/i.test(t)) {
    try {
      const u = new URL(t);
      return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    } catch {
      return t;
    }
  }
  return t.replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Extract a navigable http(s) URL from chat/markdown junk.
 * "http://localhost:5173**，已在/" → "http://localhost:5173"
 */
export function sanitizeBrowserUrl(raw: string): string {
  let text = String(raw || "").trim();
  if (!text) return "";
  if (text === "about:blank") return text;
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep */
  }

  const re = new RegExp(URL_RE.source, "i");
  const matched = text.match(re)?.[0];
  let candidate = normalizeDetectedUrl(matched || (/^https?:\/\//i.test(text) ? text : ""));
  if (!candidate) return "";

  const star = candidate.search(/\*/);
  if (star >= 0) candidate = candidate.slice(0, star);
  const nonAscii = candidate.search(/[^\x00-\x7F]/);
  if (nonAscii >= 0) candidate = candidate.slice(0, nonAscii);
  candidate = normalizeDetectedUrl(candidate);
  if (!candidate) return "";

  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return displayHttpUrl(u.toString());
  } catch {
    return "";
  }
}

export function isHttpUrl(value: string): boolean {
  return Boolean(sanitizeBrowserUrl(value));
}

/**
 * Normalize chat markdown URLs so only the clean URL becomes a link.
 *
 * - ``**http://localhost:5176**，已在`` → ``[http://localhost:5176](http://localhost:5176)，已在``
 *   (drop bold wrappers — they confuse GFM autolink and look like part of the URL)
 * - bare URLs → explicit ``[url](url)`` so GFM cannot swallow trailing junk
 */
export function prepMarkdownForUrls(src: string): string {
  let s = src || "";

  // 1) Strip ** around URLs (optional junk inside bold) → clean markdown link
  s = s.replace(/\*\*\s*((?:https?:\/\/)[^*]*?)\s*\*\*/gi, (_m, inner: string) => {
    const clean = sanitizeBrowserUrl(inner);
    return clean ? `[${clean}](${clean})` : `**${inner}**`;
  });

  // 2) Convert every remaining bare URL to an explicit link (skip inside existing links)
  let out = "";
  let i = 0;
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index;
    out += s.slice(i, start);
    const url = m[0];
    const prev2 = s.slice(Math.max(0, start - 2), start);
    const prev1 = start > 0 ? s[start - 1] : "";
    if (prev2 === "](" || prev1 === "[" || prev1 === "(") {
      out += url;
    } else {
      const clean = sanitizeBrowserUrl(url);
      out += clean ? `[${clean}](${clean})` : url;
    }
    i = start + url.length;
  }
  out += s.slice(i);

  // 3) Bare workspace files (report.html / report.pdf) → markdown links we intercept.
  return out.replace(
    /(^|[\s])((?:\.\/)?[\w./\\\-\u4e00-\u9fff]+\.(?:html?|pdf))(?=$|[\s,，。;；])/gi,
    (full, pre: string, file: string, offset: number, whole: string) => {
      const idx = offset + pre.length;
      const prev2 = whole.slice(Math.max(0, idx - 2), idx);
      const prev1 = idx > 0 ? whole[idx - 1] : "";
      if (prev2 === "](" || prev1 === "[" || prev1 === "(") return full;
      return `${pre}[${file}](${file})`;
    },
  );
}

/**
 * If anchor label contains an http(s) URL (possibly with markdown/CJK junk),
 * return clean href + how to render before/url/after.
 */
export function splitDirtyUrlLabel(label: string): {
  href: string;
  text: string;
  before: string;
  after: string;
} | null {
  const src = label || "";
  if (!src.trim()) return null;
  const re = new RegExp(URL_RE.source, "i");
  const m = re.exec(src);
  if (!m) return null;
  const href = sanitizeBrowserUrl(m[0]);
  if (!href) return null;
  return {
    href,
    text: displayHttpUrl(href),
    before: src.slice(0, m.index),
    after: src.slice(m.index + m[0].length),
  };
}

/** Ctrl/Cmd+click or right-click http(s); any click on local HTML/PDF → sandbox prompt. */
export function sandboxUrlGesture(
  url: string | undefined,
  e: {
    ctrlKey: boolean;
    metaKey: boolean;
    clientX: number;
    clientY: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  },
  onOpen: ((url: string, clientX: number, clientY: number) => void) | undefined,
  opts: { mode: "click" | "contextmenu" },
): boolean {
  const raw = url || "";
  const local = isLocalPreviewTarget(raw) ? localPreviewPath(raw) : "";
  const clean = local || sanitizeBrowserUrl(raw);
  if (!clean || !onOpen) return false;
  if (opts.mode === "click" && !local && !(e.ctrlKey || e.metaKey)) return false;
  e.preventDefault();
  e.stopPropagation();
  onOpen(clean, e.clientX, e.clientY);
  return true;
}

export type TextSegment = { type: "text"; value: string } | { type: "url"; value: string };

export function splitTextWithUrls(text: string): TextSegment[] {
  const src = text || "";
  if (!src) return [];
  const out: TextSegment[] = [];
  const re = new RegExp(URL_RE.source, "gi");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    if (start > last) out.push({ type: "text", value: src.slice(last, start) });
    const raw = m[0];
    const url = sanitizeBrowserUrl(raw);
    if (url) {
      out.push({ type: "url", value: displayHttpUrl(url) });
    } else {
      out.push({ type: "text", value: raw });
    }
    last = start + raw.length;
  }
  if (last < src.length) out.push({ type: "text", value: src.slice(last) });
  return out.length ? out : [{ type: "text", value: src }];
}
