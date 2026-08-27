import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchGit,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitPull,
  gitPush,
  gitSetRemote,
  gitStage,
  gitUnstage,
  type GitFileEntry,
  type GitSnapshot,
} from "../api";
import { usePrefs } from "../prefs";
import type { MsgKey } from "../i18n";
import { IconCheck, IconChevronDown, IconGit, IconRefresh } from "./icons";

type Props = {
  refreshKey?: number;
  onChanged?: () => void;
};

type DetailPart = { key: MsgKey; args?: string[] } | { text: string };

type Notice = {
  kind: "ok" | "err" | "warn";
  titleKey: MsgKey;
  titleArgs?: string[];
  actionKey?: MsgKey;
  details?: DetailPart[];
};

function noticeTitle(notice: Notice, t: (key: MsgKey, ...args: string[]) => string): string {
  if (notice.actionKey) return t(notice.titleKey, t(notice.actionKey));
  return t(notice.titleKey, ...(notice.titleArgs || []));
}

function noticeDetail(notice: Notice, t: (key: MsgKey, ...args: string[]) => string): string {
  return (notice.details || [])
    .map((part) => ("key" in part ? t(part.key, ...(part.args || [])) : part.text))
    .filter(Boolean)
    .join("\n");
}

function stagedFiles(snap: GitSnapshot): boolean {
  return (snap.files || []).some((f) => f.staged);
}

function parseTaggedMessage(raw: string): {
  tag: string;
  url: string;
  branch: string;
  sha: string;
  rest: string;
} | null {
  const m = raw.match(/^(PUSHED_OK|UP_TO_DATE|COMMITTED_LOCAL|PULLED):([\s\S]*)$/);
  if (!m) return null;
  const tag = m[1];
  const body = m[2] ?? "";
  if (tag === "COMMITTED_LOCAL") {
    const nl = body.indexOf("\n");
    const sha = (nl === -1 ? body : body.slice(0, nl)).trim();
    const rest = nl === -1 ? "" : body.slice(nl + 1).trim();
    return { tag, url: "", branch: "", sha, rest };
  }
  if (tag === "PULLED") {
    return { tag, url: "", branch: "", sha: "", rest: body.trim() };
  }
  const lines = body.split("\n");
  return {
    tag,
    url: (lines[0] || "").trim(),
    branch: (lines[1] || "").trim(),
    sha: (lines[2] || "").trim(),
    rest: lines.slice(3).join("\n").trim(),
  };
}

function fileStats(f: GitFileEntry) {
  const added = Number(f.added || 0);
  const deleted = Number(f.deleted || 0);
  return { added, deleted };
}

function topDir(path: string): string {
  const p = path.replace(/\\/g, "/");
  const i = p.indexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function relName(path: string, dir: string): string {
  const p = path.replace(/\\/g, "/");
  if (!dir) return p;
  return p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
}

function groupFiles(files: GitFileEntry[]): Array<{ dir: string; files: GitFileEntry[] }> {
  const map = new Map<string, GitFileEntry[]>();
  for (const f of files) {
    const dir = topDir(f.path);
    const list = map.get(dir) || [];
    list.push(f);
    map.set(dir, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, items]) => ({ dir, files: items }));
}

function fileStatusKey(f: GitFileEntry): MsgKey {
  if (f.untracked) return "gitStatusUntracked";
  if (f.staged && (f.unstaged || f.untracked)) return "gitStatusBoth";
  if (f.staged) return "gitStatusStaged";
  return "gitStatusUnstaged";
}

function suggestedStep(snap: GitSnapshot): 1 | 2 | 3 {
  const files = snap.files || [];
  const staged = files.some((f) => f.staged);
  const dirty = files.some((f) => f.unstaged || f.untracked);
  const unpublished = Number(snap.unpublished || snap.ahead || 0);
  if (staged) return 2;
  if (dirty) return 1;
  if (unpublished > 0) return 3;
  return 1;
}

export function GitPanel({ refreshKey = 0, onChanged }: Props) {
  const { t } = usePrefs();
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [moreOpen, setMoreOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchGit();
      setSnap(next);
      if (next.remote_url) setRemoteUrl(next.remote_url);
      setStep(suggestedStep(next));
    } catch (e) {
      setNotice({
        kind: "err",
        titleKey: "gitLoadFailed",
        details: [{ text: e instanceof Error ? e.message : String(e) }],
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const files = snap?.files || [];
  const groups = useMemo(() => groupFiles(files), [files]);
  const filePaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => filePaths.has(p)));
      if (next.size === 0 && filePaths.size > 0) {
        return new Set(filePaths);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [filePaths]);

  function okTitle(op: string): string {
    const map: Record<string, MsgKey> = {
      pull: "gitPullOk",
      push: "gitPushOk",
      fetch: "gitFetchOk",
      commit: "gitCommitOk",
      stage: "gitStageOk",
      stageAll: "gitStageAllOk",
      unstage: "gitUnstageOk",
      remote: "gitRemoteOk",
      checkout: "gitCheckoutOk",
      branch: "gitBranchOk",
    };
    const key = map[op];
    return key ? t(key) : t("gitOk");
  }

  function noticeFromResult(op: string, next: GitSnapshot): Notice {
    const raw = String(next.message || "").trim();
    const parsed = parseTaggedMessage(raw);
    const extra = parsed
      ? parsed.rest
      : raw && raw !== "ok" && raw !== okTitle(op)
        ? raw
        : "";
    const extraParts: DetailPart[] = extra ? [{ text: extra }] : [];
    const targetPart: DetailPart = next.remote_url || parsed?.url
      ? {
          key: "gitPushTarget",
          args: [next.remote_url || parsed?.url || "", next.branch || parsed?.branch || ""],
        }
      : { key: "gitNoRemoteHint" };

    if (op === "commit") {
      return {
        kind: "warn",
        titleKey: "gitCommitOk",
        details: [
          { key: "gitCommitOkHint" },
          ...(parsed?.sha ? [{ key: "gitLocalHead" as MsgKey, args: [parsed.sha] }] : []),
          targetPart,
          ...extraParts,
        ],
      };
    }

    if (op === "pull") {
      return {
        kind: "ok",
        titleKey: "gitPullOk",
        details: [{ key: "gitPullOkHint" }, ...extraParts],
      };
    }

    if (op === "push") {
      const verified: DetailPart[] =
        parsed?.url || parsed?.branch || parsed?.sha
          ? [
              {
                key: "gitPushVerified",
                args: [
                  parsed.url || next.remote_url || "",
                  parsed.branch || next.branch || "",
                  parsed.sha || next.head || "",
                ],
              },
            ]
          : [];
      if (parsed?.tag === "UP_TO_DATE" || (!parsed && raw.startsWith("UP_TO_DATE:"))) {
        return {
          kind: (next.unpublished || 0) > 0 || stagedFiles(next) ? "warn" : "ok",
          titleKey: "gitPushNothing",
          details: [...verified, ...extraParts],
        };
      }
      const staged = stagedFiles(next);
      return {
        kind: staged ? "warn" : "ok",
        titleKey: staged ? "gitPushStillStaged" : "gitPushOk",
        details: [...verified, ...extraParts],
      };
    }

    const titleMap: Record<string, MsgKey> = {
      pull: "gitPullOk",
      push: "gitPushOk",
      fetch: "gitFetchOk",
      commit: "gitCommitOk",
      stage: "gitStageOk",
      stageAll: "gitStageAllOk",
      unstage: "gitUnstageOk",
      remote: "gitRemoteOk",
      checkout: "gitCheckoutOk",
      branch: "gitBranchOk",
    };
    return {
      kind: "ok",
      titleKey: titleMap[op] || "gitOk",
      details: extraParts,
    };
  }

  async function run(fn: () => Promise<GitSnapshot>, op: string) {
    setBusy(op);
    setNotice(null);
    try {
      const next = await fn();
      setSnap(next);
      if (next.remote_url) setRemoteUrl(next.remote_url);
      setNotice(noticeFromResult(op, next));
      if (op === "stage" || op === "stageAll") setStep(2);
      else if (op === "commit" || op === "push") setStep(3);
      onChanged?.();
    } catch (e) {
      const names: Record<string, MsgKey> = {
        pull: "gitPull",
        push: "gitPush",
        fetch: "gitFetch",
        commit: "gitCommit",
        stage: "gitStageSelected",
        stageAll: "gitStageAll",
        unstage: "gitUnstageSelected",
        remote: "gitRemote",
        checkout: "gitBranch",
        branch: "gitNewBranch",
      };
      setNotice({
        kind: "err",
        titleKey: "gitFailed",
        ...(names[op] ? { actionKey: names[op] } : { titleArgs: [op] }),
        details: [{ text: e instanceof Error ? e.message : String(e) }],
      });
    } finally {
      setBusy("");
    }
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleDir(paths: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.path));
  const selectedList = files.filter((f) => selected.has(f.path));
  const selectedUnstaged = selectedList.filter((f) => f.unstaged || f.untracked).map((f) => f.path);
  const selectedStaged = selectedList.filter((f) => f.staged).map((f) => f.path);
  const unstagedAll = files.filter((f) => f.unstaged || f.untracked).map((f) => f.path);
  const hasStaged = files.some((f) => f.staged);
  const unpublished = Number(snap?.unpublished || snap?.ahead || 0);
  const canStep2 = hasStaged;
  const canStep3 = unpublished > 0;
  const busyNow = Boolean(busy);

  function goStep(n: 1 | 2 | 3) {
    if (n === 2 && !canStep2) {
      setNotice({ kind: "warn", titleKey: "gitStep2NeedStep1" });
      return;
    }
    if (n === 3 && !canStep3) {
      setNotice({ kind: "warn", titleKey: "gitStep3NeedStep2" });
      return;
    }
    setStep(n);
  }

  function doStep1Next() {
    if (hasStaged && !selectedUnstaged.length) {
      setStep(2);
      return;
    }
    const paths = selectedUnstaged.length ? selectedUnstaged : unstagedAll;
    if (!paths.length) {
      setNotice({ kind: "warn", titleKey: "gitStep1NeedSelect" });
      return;
    }
    void run(() => gitStage(paths), selectedUnstaged.length ? "stage" : "stageAll");
  }

  const steps: Array<{ n: 1 | 2 | 3; title: MsgKey; locked: boolean }> = [
    { n: 1, title: "gitStep1Title", locked: false },
    { n: 2, title: "gitStep2Title", locked: !canStep2 },
    { n: 3, title: "gitStep3Title", locked: !canStep3 },
  ];

  return (
    <div className="side-panel git-panel">
      <div className="side-panel-head">
        <IconGit size={16} />
        <span>{t("navGit")}</span>
        <div className="side-panel-head-actions">
          <button type="button" className="icon-btn" title={t("refresh")} onClick={() => void load()}>
            <IconRefresh size={14} />
          </button>
        </div>
      </div>
      <div className="side-panel-body">
        {loading && !snap ? <div className="muted">{t("loading")}</div> : null}
        {notice ? (
          <div className={`git-notice ${notice.kind}`} role="status">
            <strong>{noticeTitle(notice, t)}</strong>
            {noticeDetail(notice, t) ? <pre>{noticeDetail(notice, t)}</pre> : null}
          </div>
        ) : null}
        {busyNow ? <div className="muted git-busy">{t("gitBusy")}</div> : null}
        {snap && !snap.is_repo ? <div className="muted">{t("gitNotRepo")}</div> : null}
        {snap?.is_repo ? (
          <>
            <p className="hint git-flow-hint">{t("gitWizardIntro")}</p>
            <div className="git-remote-row">
              <label className="git-branch-label" htmlFor="git-remote-url">
                {t("gitRemote")}
              </label>
              <input
                id="git-remote-url"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder={t("gitRemotePlaceholder")}
                disabled={busyNow}
              />
              <button
                type="button"
                className="text-btn"
                disabled={!remoteUrl.trim() || busyNow || remoteUrl.trim() === (snap.remote_url || "")}
                onClick={() => void run(() => gitSetRemote(remoteUrl.trim()), "remote")}
              >
                {snap.remote_url ? t("gitRemoteSave") : t("gitRemoteLink")}
              </button>
            </div>

            <ol className="git-steps">
              {steps.map((s) => {
                const done =
                  (s.n === 1 && (canStep2 || canStep3)) ||
                  (s.n === 2 && canStep3) ||
                  (s.n === 3 && unpublished === 0 && step === 3 && !hasStaged);
                const active = step === s.n;
                return (
                  <li key={s.n}>
                    <button
                      type="button"
                      className={`git-step-tab${active ? " active" : ""}${s.locked ? " locked" : ""}${done && !active ? " done" : ""}`}
                      disabled={busyNow}
                      onClick={() => goStep(s.n)}
                    >
                      <span className="git-step-num">{s.n}</span>
                      <span className="git-step-label">{t(s.title)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {step === 1 ? (
              <div className="git-step-card">
                <p className="hint git-changes-hint">{t("gitStep1Hint")}</p>
                {files.length === 0 ? (
                  <div className="muted">
                    {t("gitStep1Empty")}
                    {canStep3 ? (
                      <button type="button" className="text-btn" onClick={() => setStep(3)}>
                        {t("gitStep1Skip")}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="git-select-bar">
                      <label className="git-check">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => {
                            setSelected(allSelected ? new Set() : new Set(files.map((f) => f.path)));
                          }}
                        />
                        {t("gitSelectAll")}
                      </label>
                      <span className="muted">{t("gitSelected", String(selected.size))}</span>
                      {hasStaged ? (
                        <button type="button" className="text-btn" onClick={() => setStep(2)}>
                          {t("gitStep1Skip")}
                        </button>
                      ) : null}
                    </div>
                    <ul className="git-file-list">
                      {groups.map((g) => {
                        const key = g.dir || "__root";
                        const paths = g.files.map((f) => f.path);
                        const dirOn = paths.every((p) => selected.has(p));
                        const dirSome = !dirOn && paths.some((p) => selected.has(p));
                        const folded = Boolean(collapsed[key]);
                        return (
                          <li key={key} className="git-dir-group">
                            <div className="git-dir-row">
                              <label className="git-check">
                                <input
                                  type="checkbox"
                                  checked={dirOn}
                                  ref={(el) => {
                                    if (el) el.indeterminate = dirSome;
                                  }}
                                  onChange={() => toggleDir(paths, !dirOn)}
                                />
                              </label>
                              <button
                                type="button"
                                className="git-dir-toggle"
                                onClick={() => setCollapsed((d) => ({ ...d, [key]: !folded }))}
                              >
                                <IconChevronDown size={14} className={folded ? "" : "rot-180"} />
                                <strong>{g.dir || t("gitRootFiles")}</strong>
                                <span className="muted">{t("gitDirCount", String(g.files.length))}</span>
                              </button>
                            </div>
                            {folded ? null : (
                              <ul className="git-dir-files">
                                {g.files.map((f) => {
                                  const { added, deleted } = fileStats(f);
                                  return (
                                    <li
                                      key={f.path}
                                      className={`git-file${selected.has(f.path) ? " selected" : ""}`}
                                    >
                                      <label className="git-check">
                                        <input
                                          type="checkbox"
                                          checked={selected.has(f.path)}
                                          onChange={() => toggle(f.path)}
                                        />
                                      </label>
                                      <span className={`git-chip git-kind-${f.kind || "modified"}`}>
                                        {t(fileStatusKey(f))}
                                      </span>
                                      <span className="git-path" title={f.path}>
                                        {relName(f.path, g.dir)}
                                      </span>
                                      <span className="git-file-stats">
                                        {added > 0 ? <span className="git-stat-add">+{added}</span> : null}
                                        {deleted > 0 ? <span className="git-stat-del">−{deleted}</span> : null}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                <div className="git-step-actions">
                  <button
                    type="button"
                    className="approval-btn allow"
                    disabled={busyNow || (!unstagedAll.length && !hasStaged)}
                    onClick={doStep1Next}
                  >
                    {t("gitStep1Next")}
                  </button>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="git-step-card">
                <p className="hint git-changes-hint">{t("gitStep2Hint")}</p>
                {!hasStaged ? (
                  <div className="muted">{t("gitStep2NeedStep1")}</div>
                ) : (
                  <p className="muted">{t("gitStep2Count", String(files.filter((f) => f.staged).length))}</p>
                )}
                <form
                  className="git-commit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const msg = message.trim();
                    if (!msg || !hasStaged) return;
                    void run(async () => {
                      const next = await gitCommit(msg);
                      setMessage("");
                      setSelected(new Set());
                      return next;
                    }, "commit");
                  }}
                >
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={t("gitCommitPlaceholder")}
                    disabled={busyNow || !hasStaged}
                  />
                  <div className="git-step-actions">
                    <button type="button" className="text-btn" disabled={busyNow} onClick={() => setStep(1)}>
                      {t("gitStep2Back")}
                    </button>
                    <button
                      type="submit"
                      className="approval-btn allow"
                      disabled={!message.trim() || !hasStaged || busyNow}
                    >
                      <IconCheck size={14} />
                      {t("gitStep2Next")}
                    </button>
                  </div>
                </form>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="git-step-card">
                <p className="hint git-changes-hint">{t("gitStep3Hint")}</p>
                {snap.remote_url ? (
                  <p className="muted">{t("gitPushTarget", snap.remote_url, snap.branch || "")}</p>
                ) : (
                  <p className="git-staged-warn">{t("gitStep3NeedRemote")}</p>
                )}
                {unpublished > 0 ? (
                  <p className="git-staged-warn">{t("gitLocalNotPushed", String(unpublished))}</p>
                ) : (
                  <p className="muted">{t("gitStep3Idle")}</p>
                )}
                {snap.head ? <p className="muted">{t("gitLocalHead", snap.head)}</p> : null}
                <div className="git-step-actions">
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busyNow}
                    onClick={() => setStep(canStep2 ? 2 : 1)}
                  >
                    {t("gitStep3Back")}
                  </button>
                  <button
                    type="button"
                    className="approval-btn allow"
                    disabled={busyNow || unpublished <= 0 || !remoteUrl.trim()}
                    onClick={() => void run(gitPush, "push")}
                  >
                    {t("gitStep3Next")}
                  </button>
                </div>
              </div>
            ) : null}

            <details className="git-more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
              <summary>{t("gitMore")}</summary>
              <div className="git-sync-row">
                <button type="button" className="text-btn" disabled={busyNow} onClick={() => void run(gitPull, "pull")}>
                  {t("gitDownload")}
                </button>
                <button type="button" className="text-btn" disabled={busyNow} onClick={() => void run(gitFetch, "fetch")}>
                  {t("gitFetch")}
                </button>
              </div>
              <div className="git-branch-row">
                <span className="git-branch-label">{t("gitBranch")}</span>
                <select
                  className="git-branch-select"
                  value={snap.branch || ""}
                  disabled={busyNow}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (!next || next === snap.branch) return;
                    void run(() => gitCheckout(next), "checkout");
                  }}
                >
                  {(snap.branches || []).some((b) => b.name === (snap.branch || "")) ? null : (
                    <option value={snap.branch || ""}>{snap.branch || "HEAD"}</option>
                  )}
                  {(snap.branches || []).map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.current ? "● " : ""}
                      {b.name}
                      {b.remote ? t("gitRemoteBranch") : ""}
                    </option>
                  ))}
                </select>
              </div>
              <form
                className="git-new-branch"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newBranch.trim();
                  if (!name) return;
                  void run(async () => {
                    const next = await gitCheckout(name, true);
                    setNewBranch("");
                    return next;
                  }, "branch");
                }}
              >
                <input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder={t("gitNewBranchPlaceholder")}
                  disabled={busyNow}
                />
                <button type="submit" className="text-btn" disabled={!newBranch.trim() || busyNow}>
                  {t("gitNewBranch")}
                </button>
              </form>
              {hasStaged ? (
                <button
                  type="button"
                  className="text-btn"
                  disabled={!selectedStaged.length || busyNow}
                  onClick={() => void run(() => gitUnstage(selectedStaged), "unstage")}
                >
                  {t("gitUnstageSelected")}
                </button>
              ) : null}
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}
