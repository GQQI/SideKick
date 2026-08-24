/** Select Mode chat attachment protocol (Capability A). Mirrors backend browser_protocol. */

export const DOM_ELEMENT_KIND = "dom-element";
export const DOM_PROTOCOL_VERSION = 1;

export type DomRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DomComponentHint = {
  name: string;
  framework: string;
  file_hint: string;
};

export type DomElementPayload = {
  kind: typeof DOM_ELEMENT_KIND;
  protocol_version: number;
  url: string;
  tag: string;
  xpath: string;
  css_path: string;
  id: string;
  classes: string[];
  attributes: Record<string, string>;
  inner_text: string;
  role: string;
  rect: DomRect;
  computed_styles: Record<string, string>;
  component?: DomComponentHint | null;
  outer_html: string;
  screenshot_base64?: string;
  selected_at: number;
};

export function chipLabelForDom(el: DomElementPayload): string {
  const tag = (el.tag || "node").toLowerCase();
  let s = tag;
  if (el.id) s += `#${el.id}`;
  if (el.classes?.length) s += `.${el.classes.slice(0, 2).join(".")}`;
  return `DOM · ${s}`.slice(0, 72);
}

export function formatDomElementForAgent(el: DomElementPayload): string {
  const slim: Record<string, unknown> = { ...el };
  delete slim.screenshot_base64;
  if (typeof slim.outer_html === "string" && slim.outer_html.length > 2500) {
    slim.outer_html = `${slim.outer_html.slice(0, 2500)}…`;
  }
  if (typeof slim.inner_text === "string" && slim.inner_text.length > 500) {
    slim.inner_text = `${slim.inner_text.slice(0, 500)}…`;
  }
  const body = JSON.stringify(slim, null, 2);
  return [
    "### 选中的页面元素（Select Mode）",
    "用户从内置浏览器沙盒点选了以下 DOM 节点。请根据视觉意图修改**源码**（不是运行时 DOM）；",
    "优先用 component / xpath / 文案 / class / id 定位文件。改完依赖页面热更新或刷新验证。",
    "",
    "```dom-element",
    body,
    "```",
  ].join("\n");
}

export function parseDomElement(raw: unknown): DomElementPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind && o.kind !== DOM_ELEMENT_KIND) return null;
  return {
    kind: DOM_ELEMENT_KIND,
    protocol_version: Number(o.protocol_version) || DOM_PROTOCOL_VERSION,
    url: String(o.url || ""),
    tag: String(o.tag || ""),
    xpath: String(o.xpath || ""),
    css_path: String(o.css_path || ""),
    id: String(o.id || ""),
    classes: Array.isArray(o.classes) ? o.classes.map(String) : [],
    attributes:
      o.attributes && typeof o.attributes === "object"
        ? (o.attributes as Record<string, string>)
        : {},
    inner_text: String(o.inner_text || ""),
    role: String(o.role || ""),
    rect: {
      x: Number((o.rect as DomRect | undefined)?.x) || 0,
      y: Number((o.rect as DomRect | undefined)?.y) || 0,
      width: Number((o.rect as DomRect | undefined)?.width) || 0,
      height: Number((o.rect as DomRect | undefined)?.height) || 0,
    },
    computed_styles:
      o.computed_styles && typeof o.computed_styles === "object"
        ? (o.computed_styles as Record<string, string>)
        : {},
    component: (o.component as DomComponentHint) || null,
    outer_html: String(o.outer_html || ""),
    screenshot_base64: o.screenshot_base64 ? String(o.screenshot_base64) : "",
    selected_at: Number(o.selected_at) || 0,
  };
}
