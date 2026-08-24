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
  return out;
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

/** Ctrl/Cmd+click or right-click → offer sandbox open (caller provides prompt UI). */
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
  const clean = sanitizeBrowserUrl(url || "");
  if (!clean || !onOpen) return false;
  if (opts.mode === "click" && !(e.ctrlKey || e.metaKey)) return false;
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
