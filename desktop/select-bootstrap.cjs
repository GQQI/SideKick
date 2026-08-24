/** Injected into the live BrowserView for Select Mode (Capability A). */
module.exports = function selectBootstrap(styleKeys, protocolVersion) {
  const STYLE_KEYS = styleKeys;
  const PROTOCOL_VERSION = protocolVersion;
  return `(() => {
  if (window.__sidekickSelectBooted) return true;
  window.__sidekickSelectBooted = true;
  const STYLE_KEYS = ${JSON.stringify(STYLE_KEYS)};
  const PROTOCOL_VERSION = ${Number(protocolVersion) || 1};

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }
  function xpathFor(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let i = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) i++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + "[" + i + "]");
      cur = cur.parentElement;
    }
    return "/html/body/" + parts.join("/");
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift("#" + cssEscape(cur.id)); break; }
      if (cur.classList && cur.classList.length) {
        part += "." + Array.from(cur.classList).slice(0, 2).map(cssEscape).join(".");
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  function reactHint(el) {
    const key = Object.keys(el).find((k) =>
      k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!key) return null;
    let fiber = el[key];
    for (let i = 0; i < 12 && fiber; i++) {
      const t = fiber.type;
      if (typeof t === "function") {
        const name = t.displayName || t.name;
        if (name && !name.startsWith("_")) return { name, framework: "react", file_hint: "" };
      }
      if (typeof t === "object" && t && t.displayName) {
        return { name: String(t.displayName), framework: "react", file_hint: "" };
      }
      fiber = fiber.return;
    }
    return null;
  }
  function attrsOf(el) {
    const out = {};
    if (!el || !el.attributes) return out;
    for (const a of Array.from(el.attributes).slice(0, 24)) {
      if (a.name === "class" || a.name === "style") continue;
      let v = a.value || "";
      if (v.length > 120) v = v.slice(0, 120) + "…";
      out[a.name] = v;
    }
    return out;
  }
  function stylesOf(el) {
    const cs = window.getComputedStyle(el);
    const out = {};
    for (const k of STYLE_KEYS) { try { out[k] = cs[k]; } catch (e) {} }
    return out;
  }
  function payloadFor(el) {
    const r = el.getBoundingClientRect();
    return {
      kind: "dom-element",
      protocol_version: PROTOCOL_VERSION,
      url: location.href,
      tag: (el.tagName || "").toLowerCase(),
      xpath: xpathFor(el),
      css_path: cssPath(el),
      id: el.id || "",
      classes: el.classList ? Array.from(el.classList).slice(0, 12) : [],
      attributes: attrsOf(el),
      inner_text: (el.innerText || "").trim().slice(0, 800),
      role: el.getAttribute("role") || "",
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      computed_styles: stylesOf(el),
      component: reactHint(el),
      outer_html: (() => { try { return (el.outerHTML || "").slice(0, 4000); } catch (e) { return ""; } })(),
      selected_at: Date.now() / 1000,
    };
  }
  let hl = null, armed = false, resolver = null;
  function ensureHl() {
    if (hl) return hl;
    hl = document.createElement("div");
    hl.setAttribute("data-sidekick-select-hl", "1");
    Object.assign(hl.style, {
      position: "fixed", pointerEvents: "none", zIndex: "2147483646",
      border: "2px solid #2563eb", background: "rgba(37,99,235,0.12)",
      borderRadius: "2px", display: "none",
    });
    document.documentElement.appendChild(hl);
    return hl;
  }
  function onMove(ev) {
    if (!armed) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === hl) return;
    const r = el.getBoundingClientRect();
    const box = ensureHl();
    box.style.display = "block";
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = Math.max(0, r.width) + "px";
    box.style.height = Math.max(0, r.height) + "px";
  }
  function onClick(ev) {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || el === hl) return;
    armed = false;
    if (hl) hl.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    const payload = payloadFor(el);
    const r = resolver; resolver = null;
    if (r) r(payload);
  }
  window.__sidekickSelectArm = function (timeoutMs) {
    return new Promise((resolve) => {
      if (armed && resolver) resolver(null);
      armed = true; resolver = resolve; ensureHl();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      const ms = Math.max(1000, Number(timeoutMs) || 60000);
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        if (hl) hl.style.display = "none";
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        const r = resolver; resolver = null;
        if (r) r(null);
      }, ms);
    });
  };
  window.__sidekickSelectCancel = function () {
    armed = false;
    if (hl) hl.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    const r = resolver; resolver = null;
    if (r) r(null);
  };
  return true;
})()`;
};
