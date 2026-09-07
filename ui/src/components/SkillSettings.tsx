import { useEffect, useRef, useState } from "react";
import {
  deleteSkill,
  fetchSkill,
  fetchSkills,
  importSkillDir,
  importSkillFile,
  importSkillFiles,
  saveSkill,
  updateSkill,
  validateSkill,
  type SkillItem,
  type SkillValidateResult,
} from "../api";
import { getDesktop } from "../desktopBridge";
import type { MsgKey } from "../i18n";

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  onToast?: (msg: string) => void;
  onChanged?: () => void;
};

type Draft = {
  previous: string;
  name: string;
  description: string;
  content: string;
};

const EMPTY: Draft = {
  previous: "",
  name: "",
  description: "",
  content: `# 新技能

## 何时使用
说明这个技能适合处理什么任务。

## 步骤
1. 先确认输入
2. 按顺序执行
3. 回报结果
`,
};

export function SkillSettings({ t, onToast, onChanged }: Props) {
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<SkillValidateResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);

  const reload = async () => {
    const list = await fetchSkills();
    setItems(list);
    onChanged?.();
  };

  useEffect(() => {
    void reload().catch((e) => onToast?.(e instanceof Error ? e.message : String(e)));
  }, [onToast]);

  const openEdit = async (name: string) => {
    setBusy(true);
    try {
      const detail = await fetchSkill(name);
      setCheck(null);
      setDraft({
        previous: detail.name,
        name: detail.name,
        description: detail.description,
        content: detail.body || "",
      });
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runValidate = async (next = draft) => {
    if (!next) return;
    setBusy(true);
    try {
      const res = await validateSkill({
        name: next.name,
        description: next.description,
        content: next.content,
      });
      setCheck(res);
      if (res.ok) onToast?.(t("skillsValidateOk"));
      else onToast?.(res.errors[0] || t("skillsValidateFail"));
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runSave = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await validateSkill({
        name: draft.name,
        description: draft.description,
        content: draft.content,
      });
      setCheck(res);
      if (!res.ok) {
        onToast?.(res.errors[0] || t("skillsValidateFail"));
        return;
      }
      if (draft.previous) {
        await updateSkill(draft.previous, {
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
      } else {
        await saveSkill({
          name: draft.name,
          description: draft.description,
          content: draft.content,
          overwrite: false,
        });
      }
      onToast?.(t("skillsSaved"));
      setDraft(null);
      setCheck(null);
      await reload();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async (name: string) => {
    if (!window.confirm(t("skillsDeleteConfirm", name))) return;
    setBusy(true);
    try {
      await deleteSkill(name);
      if (draft?.previous === name || draft?.name === name) {
        setDraft(null);
        setCheck(null);
      }
      onToast?.(t("skillsDeleted"));
      await reload();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finishImport = async (
    run: (overwrite: boolean) => Promise<{ imported: SkillItem[] }>,
  ) => {
    setBusy(true);
    try {
      const res = await run(false);
      onToast?.(t("skillsImported", String(res.imported.length)));
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists/i.test(msg) && window.confirm(t("skillsOverwriteConfirm"))) {
        try {
          const res = await run(true);
          onToast?.(t("skillsImported", String(res.imported.length)));
          await reload();
          return;
        } catch (e2) {
          onToast?.(e2 instanceof Error ? e2.message : String(e2));
          return;
        }
      }
      onToast?.(msg);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
      if (dirRef.current) dirRef.current.value = "";
    }
  };

  const runImport = async (file: File) => {
    await finishImport((overwrite) => importSkillFile(file, overwrite));
  };

  const runImportFolder = async () => {
    const desktop = getDesktop();
    if (desktop?.workspace?.pickFolder) {
      const picked = await desktop.workspace.pickFolder({ title: t("skillsImportDir") });
      if (picked.cancelled || !picked.path) return;
      await finishImport((overwrite) => importSkillDir(picked.path as string, overwrite));
      return;
    }
    dirRef.current?.click();
  };

  const runImportFiles = async (list: FileList) => {
    const files = Array.from(list);
    if (!files.length) return;
    await finishImport((overwrite) => importSkillFiles(files, overwrite));
  };

  if (!items) {
    return <p className="hint">{t("skillsLoading")}</p>;
  }

  return (
    <div className="skill-settings settings-pane">
      <header className="settings-pane-intro">
        <h3>{t("skillsTitle")}</h3>
        <p className="hint">{t("skillsHint")}</p>
      </header>

      <div className="mcp-toolbar">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            setCheck(null);
            setDraft({ ...EMPTY });
          }}
        >
          {t("skillsNew")}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void runImportFolder()}>
          {t("skillsImportDir")}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("skillsImportFile")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.zip,text/markdown,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void runImport(file);
          }}
        />
        <input
          ref={dirRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error Chromium folder picker
          webkitdirectory=""
          directory=""
          onChange={(e) => {
            if (e.target.files?.length) void runImportFiles(e.target.files);
          }}
        />
      </div>

      {draft && (
        <div className="mcp-card skill-editor">
          <div className="mcp-card-head">
            <label className="mcp-field grow">
              <span>{t("skillsName")}</span>
              <input
                value={draft.name}
                disabled={busy}
                placeholder="pdf-report"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
          </div>
          <label className="mcp-field">
            <span>{t("skillsDescription")}</span>
            <textarea
              rows={2}
              value={draft.description}
              disabled={busy}
              placeholder={t("skillsDescriptionHint")}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="mcp-field">
            <span>{t("skillsBody")}</span>
            <textarea
              className="skill-body"
              rows={14}
              value={draft.content}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          {check && (
            <div className={`skill-check ${check.ok ? "ok" : "bad"}`}>
              {!check.ok &&
                check.errors.map((err) => (
                  <p key={err} className="skill-check-err">
                    {err}
                  </p>
                ))}
              {check.warnings.map((warn) => (
                <p key={warn} className="skill-check-warn">
                  {warn}
                </p>
              ))}
              {check.ok && !check.warnings.length && <p>{t("skillsValidateOk")}</p>}
            </div>
          )}
          <div className="mcp-card-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void runSave()}>
              {t("skillsSave")}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void runValidate()}>
              {t("skillsValidate")}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setCheck(null);
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="mcp-list">
        {items.length === 0 && <p className="hint">{t("skillsEmpty")}</p>}
        {items.map((sk) => (
          <div key={sk.name} className="mcp-card">
            <div className="skill-row">
              <div>
                <strong>{sk.name}</strong>
                <code className="skill-tool">{sk.tool}</code>
                <p className="hint">{sk.description || t("skillsNoDesc")}</p>
              </div>
              <div className="mcp-card-actions">
                <button type="button" className="mini" disabled={busy} onClick={() => void openEdit(sk.name)}>
                  {t("skillsEdit")}
                </button>
                <button
                  type="button"
                  className="mini"
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      const detail = await fetchSkill(sk.name);
                      await runValidate({
                        previous: detail.name,
                        name: detail.name,
                        description: detail.description,
                        content: detail.body || "",
                      });
                    })()
                  }
                >
                  {t("skillsValidate")}
                </button>
                <button
                  type="button"
                  className="mini ghost danger"
                  disabled={busy}
                  onClick={() => void runDelete(sk.name)}
                >
                  {t("skillsDelete")}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
