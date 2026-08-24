import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserClose,
  browserFetchScreenshot,
  browserNavigate,
  browserSelect,
  browserSelectCancel,
  browserStart,
  browserStatus,
} from "../api";
import { parseDomElement, type DomElementPayload } from "../browser/protocol";
import { sanitizeBrowserUrl } from "../browser/urlDetect";
import { getDesktop, type DesktopBounds } from "../desktopBridge";
import { usePrefs } from "../prefs";
import { IconChevronRight, IconRefresh, IconX } from "./icons";

export type BrowserOpenRequest = {
  url: string;
  nonce: number;
};

type Props = {
  onPickElement: (el: DomElementPayload) => void;
  openRequest?: BrowserOpenRequest | null;
};

function readBounds(el: HTMLElement | null): DesktopBounds | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.max(40, Math.round(r.width)),
    height: Math.max(40, Math.round(r.height)),
  };
}

export function BrowserPanel({ onPickElement, openRequest }: Props) {
  const { t } = usePrefs();
  const desktop = getDesktop();
  const live = Boolean(desktop);

  const [url, setUrl] = useState("http://127.0.0.1:5173");
  const [sessionUrl, setSessionUrl] = useState("");
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [shotBust, setShotBust] = useState(0);
  const [shotSrc, setShotSrc] = useState("");
  const pollRef = useRef<number | null>(null);
  const shotSrcRef = useRef("");
  const sessionUrlRef = useRef("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const openSeqRef = useRef(0);
  sessionUrlRef.current = sessionUrl;

  const syncBounds = useCallback(async () => {
    if (!desktop) return;
    const bounds = readBounds(hostRef.current);
    if (!bounds) return;
    if (sessionUrlRef.current) await desktop.browser.show(bounds);
    else await desktop.browser.setBounds(bounds);
  }, [desktop]);

  const showLive = useCallback(async () => {
    if (!desktop) return;
    const bounds = readBounds(hostRef.current);
    if (!bounds) return;
    await desktop.browser.show(bounds);
  }, [desktop]);

  const refreshStatus = useCallback(async () => {
    if (live && desktop) {
      setAvailable(true);
      try {
        const cur = await desktop.browser.getUrl();
        if (cur && cur !== "about:blank") {
          setSessionUrl(cur);
          setUrl(cur);
        }
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const st = await browserStatus();
      setAvailable(st.available);
      if (st.message) setMessage(st.message);
      if (st.session?.url) {
        setSessionUrl(st.session.url);
        if (st.session.url !== "about:blank") setUrl(st.session.url);
      } else setSessionUrl("");
    } catch (e) {
      setAvailable(false);
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [desktop, live]);

  const refreshShot = useCallback(async () => {
    if (live || !sessionUrlRef.current) return;
    try {
      const next = await browserFetchScreenshot(false);
      const prev = shotSrcRef.current;
      shotSrcRef.current = next;
      setShotSrc(next);
      if (prev) URL.revokeObjectURL(prev);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [live]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Live BrowserView lifecycle + bounds sync.
  useEffect(() => {
    if (!live || !desktop) return;
    void showLive();
    const ro = new ResizeObserver(() => {
      void syncBounds();
    });
    if (hostRef.current) ro.observe(hostRef.current);
    const onWin = () => void syncBounds();
    window.addEventListener("resize", onWin);
    const offBounds = desktop.browser.onRequestBounds(() => {
      void syncBounds();
    });
    const offNav = desktop.browser.onNavigated((next) => {
      if (!next || next === "about:blank") return;
      setSessionUrl(next);
      setUrl(next);
      setMessage("");
    });
    const offFail = desktop.browser.onLoadFailure((info) => {
      setMessage(`${t("browserLoadFail")}: ${info.description || info.code} (${info.url})`);
    });
    // Layout settles after paint.
    const t1 = window.setTimeout(() => void syncBounds(), 50);
    const t2 = window.setTimeout(() => void syncBounds(), 300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      offBounds();
      offNav();
      offFail();
      void desktop.browser.hide();
    };
  }, [live, desktop, showLive, syncBounds, t]);

  useEffect(() => {
    if (live) return;
    if (!sessionUrl) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      if (shotSrcRef.current) {
        URL.revokeObjectURL(shotSrcRef.current);
        shotSrcRef.current = "";
        setShotSrc("");
      }
      return;
    }
    void refreshShot();
    pollRef.current = window.setInterval(() => setShotBust(Date.now()), 2500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [sessionUrl, refreshShot, live]);

  useEffect(() => {
    if (live || !sessionUrl || !shotBust) return;
    void refreshShot();
  }, [shotBust, sessionUrl, refreshShot, live]);

  async function openTarget(targetRaw: string) {
    const trimmed = targetRaw.trim() || "about:blank";
    const target =
      trimmed === "about:blank" ? trimmed : sanitizeBrowserUrl(trimmed) || trimmed;
    if (trimmed !== "about:blank" && !sanitizeBrowserUrl(trimmed)) {
      setMessage(`无效地址（已剥离 markdown/中文残留）: ${trimmed}`);
      return;
    }
    const seq = ++openSeqRef.current;
    setUrl(target);
    setBusy(true);
    setMessage(live ? t("browserOpeningLive") : "");
    try {
      if (desktop) {
        await showLive();
        await syncBounds();
        const info = await desktop.browser.navigate(target);
        if (seq !== openSeqRef.current) return;
        setSessionUrl(info.url);
        setUrl(info.url);
        setMessage("");
        await syncBounds();
      } else {
        const info = sessionUrlRef.current
          ? await browserNavigate(target)
          : await browserStart(target, false);
        if (seq !== openSeqRef.current) return;
        setSessionUrl(info.url);
        setUrl(info.url);
        setShotBust(Date.now());
        setMessage("");
      }
    } catch (e) {
      if (seq === openSeqRef.current) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  async function startOrGo() {
    await openTarget(url);
  }

  useEffect(() => {
    if (!openRequest?.url || !openRequest.nonce) return;
    void openTarget(openRequest.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.nonce]);

  async function closeSession() {
    setBusy(true);
    try {
      if (desktop) {
        await desktop.browser.navigate("about:blank");
        await desktop.browser.hide();
        setSessionUrl("");
        setMessage("");
      } else {
        await browserClose();
        setSessionUrl("");
        setShotBust(0);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function armSelect() {
    if (!sessionUrl) await startOrGo();
    setPicking(true);
    setMessage(t("browserSelectHint"));
    try {
      if (desktop) {
        await syncBounds();
        const raw = await desktop.browser.selectArm(90000);
        const el = raw ? parseDomElement(raw) : null;
        if (el) onPickElement(el);
        setMessage(el ? t("browserSelectOk") : t("browserSelectCancel"));
      } else {
        const res = await browserSelect(90000, true);
        if (res.ok && res.element) {
          const el = parseDomElement(res.element);
          if (el) onPickElement(el);
          setMessage(t("browserSelectOk"));
        } else setMessage(res.message || t("browserSelectCancel"));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
      if (!live) setShotBust(Date.now());
    }
  }

  async function cancelSelect() {
    try {
      if (desktop) await desktop.browser.selectCancel();
      else await browserSelectCancel();
    } catch {
      /* ignore */
    }
    setPicking(false);
    setMessage(t("browserSelectCancel"));
  }

  return (
    <div className="side-panel browser-panel">
      <div className="side-panel-head">
        <strong>{t("navBrowser")}</strong>
        <span className={`browser-mode-badge${live ? " live" : ""}`}>
          {live ? t("browserModeLive") : t("browserModeShot")}
        </span>
        <div className="side-panel-head-actions">
          {live ? (
            <>
              <button
                type="button"
                className="icon-btn browser-nav-back"
                title={t("browserBack")}
                disabled={busy}
                onClick={() => void desktop?.browser.goBack()}
              >
                <IconChevronRight size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t("browserForward")}
                disabled={busy}
                onClick={() => void desktop?.browser.goForward()}
              >
                <IconChevronRight size={16} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            title={t("browserRefreshShot")}
            disabled={!sessionUrl || busy}
            onClick={() => {
              if (desktop) void desktop.browser.reload();
              else setShotBust(Date.now());
            }}
          >
            <IconRefresh size={16} />
          </button>
          {sessionUrl ? (
            <button
              type="button"
              className="icon-btn"
              title={t("browserClose")}
              disabled={busy}
              onClick={() => void closeSession()}
            >
              <IconX size={16} />
            </button>
          ) : null}
        </div>
      </div>

      {!live && (
        <p className="browser-host-hint muted">{t("browserHostHint")}</p>
      )}

      <form
        className="browser-url-row"
        onSubmit={(e) => {
          e.preventDefault();
          void startOrGo();
        }}
      >
        <input
          className="browser-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:3000"
          spellCheck={false}
        />
        <button type="submit" className="chip action" disabled={busy || picking}>
          {sessionUrl ? t("browserGo") : t("browserStart")}
        </button>
      </form>

      <div className="browser-actions">
        <button
          type="button"
          className={`chip action${picking ? " warn" : ""}`}
          disabled={busy || (!available && !sessionUrl && !live)}
          onClick={() => void (picking ? cancelSelect() : armSelect())}
        >
          {picking ? t("browserSelecting") : t("browserSelect")}
        </button>
      </div>

      {!available && !live && (
        <p className="browser-warn">{message || t("browserUnavailable")}</p>
      )}
      {message ? <p className="hint browser-msg">{message}</p> : null}

      <div
        className={`browser-preview${live ? " browser-preview-live" : ""}${
          live && sessionUrl ? " has-session" : ""
        }`}
        ref={hostRef}
      >
        {live ? (
          <p className="hint browser-live-placeholder">
            {sessionUrl ? t("browserLiveActive") : t("browserPreviewEmpty")}
          </p>
        ) : shotSrc ? (
          <img src={shotSrc} alt={t("browserPreviewAlt")} className="browser-shot" />
        ) : (
          <p className="hint">{t("browserPreviewEmpty")}</p>
        )}
      </div>

      {sessionUrl ? (
        <p className="hint browser-session-url" title={sessionUrl}>
          {chipLabelSession(sessionUrl)}
        </p>
      ) : null}
    </div>
  );
}

function chipLabelSession(u: string) {
  try {
    const parsed = new URL(u);
    return parsed.host + parsed.pathname;
  } catch {
    return u;
  }
}

export type { DomElementPayload };
