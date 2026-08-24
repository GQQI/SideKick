import { useMemo, useState } from "react";
import type {
  ModelSetup,
  ModelProvider,
  ModelEntry,
  VendorTemplate,
  ModelRef,
} from "../types/modelSetup";
import { modelLabel, newModelEntry, refKey } from "../types/modelSetup";
import type { MsgKey } from "../i18n";

type Props = {
  setup: ModelSetup;
  locale: "zh" | "en";
  onChange: (next: ModelSetup) => void;
  onSave: (next?: ModelSetup, opts?: { restartChat?: boolean }) => void;
  saving?: boolean;
  t: (key: MsgKey, ...args: string[]) => string;
};

type MarketKind = "deepseek" | "openai" | "ollama" | "custom";

const MARKET: Array<{
  id: MarketKind;
  nameZh: string;
  nameEn: string;
  descZh: string;
  descEn: string;
  tags: string[];
}> = [
  { id: "deepseek", nameZh: "DeepSeek", nameEn: "DeepSeek", descZh: "官方 API", descEn: "Official API", tags: ["LLM"] },
  { id: "openai", nameZh: "OpenAI", nameEn: "OpenAI", descZh: "官方 API", descEn: "Official API", tags: ["LLM"] },
  { id: "ollama", nameZh: "Ollama", nameEn: "Ollama", descZh: "本机本地模型", descEn: "Local models", tags: ["LLM"] },
  {
    id: "custom",
    nameZh: "OpenAI-API-Compatible",
    nameEn: "OpenAI-API-Compatible",
    descZh: "任意兼容接口 / 网关",
    descEn: "Any compatible gateway",
    tags: ["LLM"],
  },
];

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function newProvider(
  kind: MarketKind,
  templates: Record<string, VendorTemplate>,
  existingNames: string[],
): ModelProvider {
  const tpl = templates[kind] || templates.custom;
  const market = MARKET.find((m) => m.id === kind);
  const baseName = market ? market.nameZh : tpl?.name || kind;
  const baseUrl = tpl?.base_url || "";
  const models = (tpl?.models || []).map((n) => newModelEntry(n, { base_url: baseUrl }));
  return {
    id: `prov_${Math.random().toString(36).slice(2, 10)}`,
    name: uniqueName(baseName, existingNames),
    vendor: tpl?.vendor || "openai",
    market_id: kind,
    models,
  };
}

function setRole(setup: ModelSetup, role: "main" | "subagent", ref: ModelRef): ModelSetup {
  const next: ModelSetup = { ...setup, [role]: ref };
  if (role === "subagent") next.compress = { ...ref };
  return next;
}

function badge(kind: string): string {
  if (kind === "deepseek") return "DS";
  if (kind === "openai") return "OA";
  if (kind === "ollama") return "OL";
  return "API";
}

type EditTarget = { providerId: string; modelId: string };

export function ModelSettings({ setup, locale, onChange, onSave, saving, t }: Props) {
  const templates = setup.vendor_templates || {};
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showKey, setShowKey] = useState(false);
  const [marketQuery, setMarketQuery] = useState("");

  const editingModel = useMemo(() => {
    if (!edit) return null;
    const prov = setup.providers.find((p) => p.id === edit.providerId);
    const model = prov?.models.find((m) => m.id === edit.modelId) || null;
    return prov && model ? { prov, model } : null;
  }, [edit, setup.providers]);

  const marketList = useMemo(() => {
    const q = marketQuery.trim().toLowerCase();
    return MARKET.filter(
      (m) =>
        !q ||
        m.nameZh.toLowerCase().includes(q) ||
        m.nameEn.toLowerCase().includes(q) ||
        m.descZh.includes(q),
    );
  }, [marketQuery]);

  function patchModel(providerId: string, modelId: string, patch: Partial<ModelEntry>) {
    onChange({
      ...setup,
      providers: setup.providers.map((p) =>
        p.id !== providerId
          ? p
          : {
              ...p,
              models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
            },
      ),
    });
  }

  function addFromMarket(kind: MarketKind) {
    const p = newProvider(
      kind,
      templates,
      setup.providers.map((x) => x.name),
    );
    onChange({ ...setup, providers: [...setup.providers, p] });
    setExpanded((d) => ({ ...d, [p.id]: true }));
    if (p.models[0]) {
      setEdit({ providerId: p.id, modelId: p.models[0].id });
      setShowKey(false);
    }
  }

  function removeProvider(id: string) {
    const next = setup.providers.filter((p) => p.id !== id);
    const fallback = next[0]?.models[0];
    const remap = (ref: ModelRef): ModelRef => {
      if (ref.provider_id !== id) return ref;
      return fallback
        ? { provider_id: next[0].id, model_id: fallback.id }
        : { provider_id: "", model_id: "" };
    };
    onChange({
      ...setup,
      providers: next,
      main: remap(setup.main),
      subagent: remap(setup.subagent),
      compress: remap(setup.compress),
    });
    if (edit?.providerId === id) setEdit(null);
  }

  function addBlankModel(provider: ModelProvider) {
    const tpl = templates[provider.market_id || ""] || templates.custom;
    const entry = newModelEntry("", { base_url: tpl?.base_url || "" });
    onChange({
      ...setup,
      providers: setup.providers.map((p) =>
        p.id === provider.id ? { ...p, models: [...p.models, entry] } : p,
      ),
    });
    setExpanded((d) => ({ ...d, [provider.id]: true }));
    setEdit({ providerId: provider.id, modelId: entry.id });
    setShowKey(false);
  }

  function removeModel(providerId: string, modelId: string) {
    const prov = setup.providers.find((p) => p.id === providerId);
    if (!prov) return;
    const models = prov.models.filter((m) => m.id !== modelId);
    let next: ModelSetup = {
      ...setup,
      providers: setup.providers.map((p) => (p.id === providerId ? { ...p, models } : p)),
    };
    const fallback = models[0] || next.providers.find((p) => p.models[0])?.models[0];
    const fallbackProv =
      models[0]
        ? providerId
        : next.providers.find((p) => p.models.some((m) => m.id === fallback?.id))?.id || "";
    for (const role of ["main", "subagent", "compress"] as const) {
      if (next[role].model_id === modelId) {
        next = {
          ...next,
          [role]: fallback
            ? { provider_id: fallbackProv, model_id: fallback.id }
            : { provider_id: "", model_id: "" },
        };
      }
    }
    onChange(next);
    if (edit?.modelId === modelId) setEdit(null);
  }

  function pickRole(role: "main" | "subagent", key: string) {
    const i = key.indexOf("::");
    if (i <= 0) return;
    onChange(
      setRole(setup, role, {
        provider_id: key.slice(0, i),
        model_id: key.slice(i + 2),
      }),
    );
  }

  function openEdit(providerId: string, modelId: string) {
    setEdit({ providerId, modelId });
    setShowKey(false);
  }

  function closeEdit() {
    setEdit(null);
    setShowKey(false);
  }

  function handleDone() {
    setEdit(null);
    setShowKey(false);
    onSave(setup, { restartChat: false });
  }

  function handleSaveAndNewChat() {
    setEdit(null);
    setShowKey(false);
    onSave(setup, { restartChat: true });
  }

  const hasModels = setup.providers.some((p) => p.models.length > 0);

  return (
    <div className="rf">
      {setup.demo_mode ? <p className="rf-banner">{t("modelDemoHint")}</p> : null}

      <div className="rf-layout">
        <div className="rf-main">
          <section className="rf-block">
            <h3 className="rf-block-title">{t("modelStepAgents")}</h3>
            <div className="rf-defaults">
              {(["main", "subagent"] as const).map((role) => {
                const ref = role === "main" ? setup.main : setup.subagent;
                return (
                  <label key={role}>
                    <span>{role === "main" ? t("mainModel") : t("subModel")}</span>
                    <select
                      value={refKey(ref)}
                      disabled={!hasModels}
                      onChange={(e) => pickRole(role, e.target.value)}
                    >
                      {!hasModels ? (
                        <option value="">{t("modelPickProviderFirst")}</option>
                      ) : (
                        setup.providers.map((p) =>
                          p.models.length === 0 ? null : (
                            <optgroup key={p.id} label={p.name}>
                              {p.models.map((m) => (
                                <option
                                  key={m.id}
                                  value={refKey({ provider_id: p.id, model_id: m.id })}
                                >
                                  {m.name || (locale === "en" ? "(unnamed)" : "（未命名）")}
                                </option>
                              ))}
                            </optgroup>
                          ),
                        )
                      )}
                    </select>
                    <em>{modelLabel(setup, ref) || "—"}</em>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="rf-block">
            <div className="rf-block-head">
              <h3 className="rf-block-title">{t("modelAddedTitle")}</h3>
              <button
                type="button"
                className="primary rf-save"
                disabled={saving}
                onClick={handleSaveAndNewChat}
              >
                {t("saveModel")}
              </button>
            </div>

            {setup.providers.length === 0 ? (
              <p className="rf-empty">{t("modelMarketEmpty")}</p>
            ) : (
              <ul className="rf-added">
                {setup.providers.map((p) => {
                  const kind = p.market_id || p.vendor || "custom";
                  const show = expanded[p.id] ?? true;
                  const readyCount = p.models.filter((m) => m.api_key_set || m.api_key).length;
                  return (
                    <li key={p.id} className="rf-added-card">
                      <div className="rf-added-top">
                        <span className={`rf-logo v-${kind}`}>{badge(kind)}</span>
                        <div className="rf-added-info">
                          <strong>{p.name}</strong>
                          <span>
                            {locale === "en"
                              ? `${p.models.length} models · ${readyCount} ready`
                              : `${p.models.length} 个模型 · ${readyCount} 已配 Key`}
                          </span>
                        </div>
                        <div className="rf-added-actions">
                          <button
                            type="button"
                            className="rf-icon-btn"
                            title={locale === "en" ? "Add model" : "添加模型"}
                            onClick={() => addBlankModel(p)}
                          >
                            +
                          </button>
                          <button
                            type="button"
                            className="rf-icon-btn danger"
                            title={t("providerRemove")}
                            onClick={() => removeProvider(p.id)}
                          >
                            🗑
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="rf-models-toggle"
                        onClick={() => setExpanded((d) => ({ ...d, [p.id]: !show }))}
                      >
                        {show
                          ? locale === "en"
                            ? "Hide models"
                            : "收起模型"
                          : locale === "en"
                            ? `Show models (${p.models.length})`
                            : `展示更多模型 (${p.models.length})`}
                        <span aria-hidden>{show ? "▴" : "▾"}</span>
                      </button>

                      {show ? (
                        <div className="rf-model-panel">
                          {p.models.length === 0 ? (
                            <p className="hint">{t("modelAddModelsHint")}</p>
                          ) : (
                            <ul className="rf-model-rows">
                              {p.models.map((m) => {
                                const mainOn =
                                  setup.main.provider_id === p.id && setup.main.model_id === m.id;
                                const subOn =
                                  setup.subagent.provider_id === p.id &&
                                  setup.subagent.model_id === m.id;
                                const ready = Boolean(m.api_key_set || m.api_key);
                                return (
                                  <li key={m.id}>
                                    <button
                                      type="button"
                                      className="rf-model-open"
                                      onClick={() => openEdit(p.id, m.id)}
                                      title={locale === "en" ? "Configure this model" : "配置此模型"}
                                    >
                                      <code>{m.name || "—"}</code>
                                      <span className={`rf-dot${ready ? " ok" : ""}`} />
                                    </button>
                                    <div className="rf-model-row-actions">
                                      <button
                                        type="button"
                                        className={`rf-pill${mainOn ? " on" : ""}`}
                                        onClick={() =>
                                          pickRole(
                                            "main",
                                            refKey({ provider_id: p.id, model_id: m.id }),
                                          )
                                        }
                                      >
                                        {locale === "en" ? "Main" : "主"}
                                      </button>
                                      <button
                                        type="button"
                                        className={`rf-pill${subOn ? " on" : ""}`}
                                        onClick={() =>
                                          pickRole(
                                            "subagent",
                                            refKey({ provider_id: p.id, model_id: m.id }),
                                          )
                                        }
                                      >
                                        {locale === "en" ? "Sub" : "子"}
                                      </button>
                                      <button
                                        type="button"
                                        className="rf-icon-btn"
                                        onClick={() => openEdit(p.id, m.id)}
                                      >
                                        ⚙
                                      </button>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <button
                            type="button"
                            className="rf-add-model-link"
                            onClick={() => addBlankModel(p)}
                          >
                            + {locale === "en" ? "Add model" : "添加模型"}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="rf-market">
          <h3 className="rf-block-title">{t("modelAvailableTitle")}</h3>
          <input
            className="rf-market-search"
            value={marketQuery}
            onChange={(e) => setMarketQuery(e.target.value)}
            placeholder={locale === "en" ? "Search providers…" : "搜索厂商…"}
          />
          <ul className="rf-market-list">
            {marketList.map((item) => (
              <li key={item.id}>
                <button type="button" className="rf-market-card" onClick={() => addFromMarket(item.id)}>
                  <span className={`rf-logo v-${item.id}`}>{badge(item.id)}</span>
                  <span className="rf-market-text">
                    <strong>{locale === "en" ? item.nameEn : item.nameZh}</strong>
                    <em>{locale === "en" ? item.descEn : item.descZh}</em>
                    <span className="rf-market-tags">
                      {item.tags.map((tag) => (
                        <i key={tag}>{tag}</i>
                      ))}
                    </span>
                  </span>
                  <span className="rf-market-add">+</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {editingModel ? (
        <div
          className="rf-drawer-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEdit();
          }}
        >
          <div className="rf-drawer" role="dialog" aria-label={editingModel.model.name || "model"}>
            <div className="rf-drawer-head">
              <h3>{locale === "en" ? "Configure model" : "配置模型"}</h3>
              <button type="button" className="icon-btn" onClick={closeEdit}>
                ✕
              </button>
            </div>
            <div className="rf-drawer-body">
              <p className="rf-drawer-sub">
                {editingModel.prov.name}
              </p>
              <label>
                <span>{locale === "en" ? "Model name (API id)" : "模型名称 (model_name)"}</span>
                <input
                  value={editingModel.model.name}
                  onChange={(e) =>
                    patchModel(editingModel.prov.id, editingModel.model.id, {
                      name: e.target.value,
                    })
                  }
                  placeholder={t("modelNamePlaceholder")}
                />
              </label>
              <label>
                <span>Base URL</span>
                <input
                  value={editingModel.model.base_url}
                  onChange={(e) =>
                    patchModel(editingModel.prov.id, editingModel.model.id, {
                      base_url: e.target.value,
                    })
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                <span>API Key</span>
                <div className="rf-key-row">
                  <input
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-..."
                    value={editingModel.model.api_key || ""}
                    onChange={(e) =>
                      patchModel(editingModel.prov.id, editingModel.model.id, {
                        api_key: e.target.value,
                        api_key_set: Boolean(e.target.value.trim()),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="rf-key-eye"
                    title={
                      showKey
                        ? locale === "en"
                          ? "Hide"
                          : "隐藏"
                        : locale === "en"
                          ? "Show"
                          : "显示"
                    }
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? "🙈" : "👁"}
                  </button>
                </div>
              </label>
            </div>
            <div className="rf-drawer-foot">
              <button
                type="button"
                className="mini danger"
                onClick={() => {
                  removeModel(editingModel.prov.id, editingModel.model.id);
                  setEdit(null);
                  setShowKey(false);
                }}
              >
                {locale === "en" ? "Delete model" : "删除模型"}
              </button>
              <button type="button" className="primary" disabled={saving} onClick={handleDone}>
                {saving
                  ? locale === "en"
                    ? "Saving…"
                    : "保存中…"
                  : locale === "en"
                    ? "Done"
                    : "完成"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
