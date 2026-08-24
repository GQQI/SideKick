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
import { IconCheck, IconGit, IconRefresh } from "./icons";

type Props = {
  refreshKey?: number;
  onChanged?: () => void;
};

function fileStats(f: GitFileEntry) {
  const added = Number(f.added || 0);
  const deleted = Number(f.deleted || 0);
  return { added, deleted };
}

export function GitPanel({ refreshKey = 0, onChanged }: Props) {
  const { t } = usePrefs();
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const next = await fetchGit();
      setSnap(next);
      if (next.remote_url) setRemoteUrl(next.remote_url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const files = snap?.files || [];
  const filePaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => filePaths.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [filePaths]);

  async function run(fn: () => Promise<GitSnapshot>, label = "*") {
    setBusy(label);
    setErr("");
    try {
      const next = await fn();
      setSnap(next);
      if (next.remote_url) setRemoteUrl(next.remote_url);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  const allSelected = files.length > 0 && files.every((f) => selected.has(f.path));
  const selectedList = files.filter((f) => selected.has(f.path));
  const selectedUnstaged = selectedList.filter((f) => f.unstaged || f.untracked).map((f) => f.path);
  const selectedStaged = selectedList.filter((f) => f.staged).map((f) => f.path);

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
        {err ? <div className="side-error">{err}</div> : null}
        {busy ? <div className="muted">{t("gitBusy")}</div> : null}
        {snap && !snap.is_repo ? <div className="muted">{t("gitNotRepo")}</div> : null}
        {snap?.is_repo ? (
          <>
            <div className="git-remote-row">
              <label className="git-branch-label" htmlFor="git-remote-url">
                {t("gitRemote")}
              </label>
              <input
                id="git-remote-url"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder={t("gitRemotePlaceholder")}
                disabled={Boolean(busy)}
              />
              <button
                type="button"
                className="text-btn"
                disabled={!remoteUrl.trim() || Boolean(busy) || remoteUrl.trim() === (snap.remote_url || "")}
                onClick={() => void run(() => gitSetRemote(remoteUrl.trim()), "remote")}
              >
                {snap.remote_url ? t("gitRemoteSave") : t("gitRemoteLink")}
              </button>
            </div>
            <div className="git-sync-row">
              <button type="button" className="text-btn" disabled={Boolean(busy)} onClick={() => void run(gitFetch, "fetch")}>
                {t("gitFetch")}
              </button>
              <button type="button" className="text-btn" disabled={Boolean(busy)} onClick={() => void run(gitPull, "pull")}>
                {t("gitPull")}
              </button>
              <button type="button" className="text-btn" disabled={Boolean(busy)} onClick={() => void run(gitPush, "push")}>
                {t("gitPush")}
              </button>
              {snap.upstream ? (
                <span className="muted git-ahead-behind">
                  {t("gitAheadBehind", String(snap.ahead || 0), String(snap.behind || 0))}
                </span>
              ) : (
                <span className="muted">{t("gitNoUpstream")}</span>
              )}
            </div>
            <div className="git-branch-row">
              <span className="git-branch-label">{t("gitBranch")}</span>
              <select
                className="git-branch-select"
                value={snap.branch || ""}
                disabled={Boolean(busy)}
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
                disabled={Boolean(busy)}
              />
              <button type="submit" className="text-btn" disabled={!newBranch.trim() || Boolean(busy)}>
                {t("gitNewBranch")}
              </button>
            </form>
            {files.length === 0 ? (
              <div className="muted">{t("gitClean")}</div>
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
                  <button
                    type="button"
                    className="text-btn"
                    disabled={!selectedUnstaged.length || Boolean(busy)}
                    onClick={() => void run(() => gitStage(selectedUnstaged), "stage")}
                  >
                    {t("gitStageSelected")}
                  </button>
                  <button
                    type="button"
                    className="text-btn"
                    disabled={!selectedStaged.length || Boolean(busy)}
                    onClick={() => void run(() => gitUnstage(selectedStaged), "unstage")}
                  >
                    {t("gitUnstageSelected")}
                  </button>
                </div>
                <ul className="git-file-list">
                  {files.map((f: GitFileEntry) => {
                    const { added, deleted } = fileStats(f);
                    return (
                      <li key={f.path} className={`git-file${selected.has(f.path) ? " selected" : ""}`}>
                        <label className="git-check">
                          <input
                            type="checkbox"
                            checked={selected.has(f.path)}
                            onChange={() => toggle(f.path)}
                          />
                        </label>
                        <span className={`git-xy git-kind-${f.kind || "modified"}`} title={f.xy}>
                          {f.kind === "deleted" ? "D" : f.kind === "untracked" || f.kind === "added" ? "A" : f.xy}
                        </span>
                        <span className="git-path" title={f.path}>
                          {f.path}
                        </span>
                        <span className="git-file-stats">
                          {added > 0 ? <span className="git-stat-add">+{added}</span> : null}
                          {deleted > 0 ? <span className="git-stat-del">−{deleted}</span> : null}
                        </span>
                        {f.unstaged || f.untracked ? (
                          <button
                            type="button"
                            className="text-btn"
                            disabled={Boolean(busy)}
                            onClick={() => void run(() => gitStage([f.path]), f.path)}
                          >
                            {t("gitStage")}
                          </button>
                        ) : (
                          <span />
                        )}
                        {f.staged ? (
                          <button
                            type="button"
                            className="text-btn"
                            disabled={Boolean(busy)}
                            onClick={() => void run(() => gitUnstage([f.path]), f.path)}
                          >
                            {t("gitUnstage")}
                          </button>
                        ) : (
                          <span />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <form
              className="git-commit"
              onSubmit={(e) => {
                e.preventDefault();
                const msg = message.trim();
                if (!msg) return;
                void run(async () => {
                  const next = await gitCommit(msg);
                  setMessage("");
                  return next;
                }, "commit");
              }}
            >
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("gitCommitPlaceholder")}
              />
              <button type="submit" className="approval-btn allow" disabled={!message.trim() || Boolean(busy)}>
                <IconCheck size={14} />
                {t("gitCommit")}
              </button>
            </form>
          </>
        ) : null}
      </div>
    </div>
  );
}
