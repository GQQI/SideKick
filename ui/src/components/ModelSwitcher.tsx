import { useEffect, useRef, useState } from "react";
import type { ModelSetup, ModelRole } from "../types/modelSetup";
import { allModelOptions, modelLabel, refKey } from "../types/modelSetup";
import type { MsgKey } from "../i18n";

type Props = {
  setup: ModelSetup | null;
  locale: "zh" | "en";
  role: ModelRole;
  onRoleChange: (role: ModelRole) => void;
  onSelect: (role: ModelRole, providerId: string, modelId: string) => void;
  onOpenSettings: () => void;
  t: (key: MsgKey, ...args: string[]) => string;
};

export function ModelSwitcher({
  setup,
  locale,
  role,
  onRoleChange,
  onSelect,
  onOpenSettings,
  t,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const currentRef = role === "main" ? setup?.main : setup?.subagent;
  const label = setup?.demo_mode
    ? "Demo"
    : modelLabel(setup, currentRef) || t("modelSwitch");

  const options = allModelOptions(setup, { requireKey: true });
  const ready = options.filter((o) => !o.disabled);
  const pending = options.filter((o) => o.disabled);
  const groupedReady = ready.reduce<Record<string, typeof ready>>((acc, o) => {
    (acc[o.provider_name] ||= []).push(o);
    return acc;
  }, {});

  const activeKey = currentRef ? refKey(currentRef) : "";

  return (
    <div className="model-switcher" ref={rootRef}>
      <button
        type="button"
        className={`chip status-link model-switcher-btn ${setup?.demo_mode ? "warn" : "ok"}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-switcher-label">{label}</span>
        <span className="model-switcher-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="model-switcher-menu" role="menu">
          <div className="model-switcher-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={role === "main" ? "active" : ""}
              onClick={() => onRoleChange("main")}
            >
              {t("mainModel")}
            </button>
            <button
              type="button"
              role="tab"
              className={role === "subagent" ? "active" : ""}
              onClick={() => onRoleChange("subagent")}
            >
              {t("subModel")}
            </button>
          </div>
          <div className="model-switcher-scroll">
            {Object.keys(groupedReady).length === 0 ? (
              <p className="hint model-switcher-empty">
                {locale === "en" ? "Configure API keys in settings first." : "请先在设置中配置 API Key。"}
              </p>
            ) : (
              Object.entries(groupedReady).map(([provName, items]) => (
                <div key={provName} className="model-switcher-group">
                  <div className="model-switcher-group-title">{provName}</div>
                  {items.map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      role="menuitem"
                      className={`model-switcher-item${activeKey === o.key ? " active" : ""}`}
                      onClick={() => {
                        onSelect(role, o.provider_id, o.model_id);
                        setOpen(false);
                      }}
                    >
                      <span>{o.model}</span>
                      {activeKey === o.key ? <em>✓</em> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
            {pending.length > 0 ? (
              <div className="model-switcher-group muted">
                <div className="model-switcher-group-title">
                  {locale === "en" ? "Needs API key" : "待配置 Key"}
                </div>
                {pending.map((o) => (
                  <div key={o.key} className="model-switcher-item disabled static">
                    <span>{o.provider_name} / {o.model}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="model-switcher-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            {t("modelManage")}
          </button>
        </div>
      )}
    </div>
  );
}
