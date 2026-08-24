import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMemoryLibrary,
  saveMemoryLibrary,
  type MemoryCategory,
  type MemoryItem,
  type MemoryLibrary,
} from "../api";
import { IconBook, IconCheck, IconPencil, IconPlus, IconSearch, IconTrash, IconX } from "./icons";
import type { MsgKey } from "../i18n";

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  onToast?: (msg: string) => void;
  onBack?: () => void;
};

type NoteHit = { cat: MemoryCategory; mem: MemoryItem };

function nid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2, 12)}`;
}

function emptyLibrary(): MemoryLibrary {
  return {
    version: 1,
    categories: [{ id: nid("cat"), name: "通用", memories: [] }],
  };
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，;；\s]+/)) {
    const tag = part.trim().replace(/^#/, "");
    if (!tag) continue;
    const k = tag.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
    if (out.length >= 16) break;
  }
  return out;
}

function matchesNote(m: MemoryItem, q: string) {
  return (
    m.tags.some((x) => x.toLowerCase().includes(q)) ||
    m.title.toLowerCase().includes(q) ||
    m.content.toLowerCase().includes(q)
  );
}

export function MemoryLibraryPanel({ t, onToast, onBack }: Props) {
  const [lib, setLib] = useState<MemoryLibrary | null>(null);
  const [catId, setCatId] = useState("");
  const [memId, setMemId] = useState("");
  const [query, setQuery] = useState("");
  const [catQuery, setCatQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [confirmCatId, setConfirmCatId] = useState("");
  const [confirmMem, setConfirmMem] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const newCatRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const draftRef = useRef({ title: "", tags: "", content: "" });
  const lastClickedRef = useRef<string>("");

  dirtyRef.current = dirty;
  draftRef.current = { title: draftTitle, tags: draftTags, content: draftContent };

  const load = useCallback(async () => {
    const next = await fetchMemoryLibrary();
    const libNext = next?.categories?.length ? next : emptyLibrary();
    setLib(libNext);
    setCatId((id) =>
      libNext.categories.some((c) => c.id === id) ? id : libNext.categories[0]?.id || "",
    );
    setMemId((id) => {
      const all = libNext.categories.flatMap((c) => c.memories);
      return all.some((m) => m.id === id) ? id : "";
    });
  }, []);

  useEffect(() => {
    void load().catch((e) => onToast?.(e instanceof Error ? e.message : String(e)));
  }, [load, onToast]);

  useEffect(() => {
    if (addingCat) newCatRef.current?.focus();
  }, [addingCat]);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  const qPage = query.trim().toLowerCase();
  const qCat = catQuery.trim().toLowerCase();

  const filteredCats = useMemo(() => {
    if (!lib) return [];
    return lib.categories.filter((c) => {
      if (qCat && !c.name.toLowerCase().includes(qCat)) return false;
      if (qPage) {
        return c.name.toLowerCase().includes(qPage) || c.memories.some((m) => matchesNote(m, qPage));
      }
      return true;
    });
  }, [lib, qCat, qPage]);

  const cat = lib?.categories.find((c) => c.id === catId) || lib?.categories[0];

  const visibleNotes: NoteHit[] = useMemo(() => {
    if (!lib) return [];
    const source = qCat ? filteredCats : lib.categories;
    if (qPage) {
      return source.flatMap((c) =>
        c.memories
          .filter((m) => matchesNote(m, qPage) || c.name.toLowerCase().includes(qPage))
          .map((mem) => ({ cat: c, mem })),
      );
    }
    return (cat?.memories || []).map((mem) => ({ cat: cat!, mem }));
  }, [lib, qPage, qCat, filteredCats, cat]);

  const selected =
    lib?.categories.flatMap((c) => c.memories).find((m) => m.id === memId) ||
    visibleNotes.find((h) => h.mem.id === memId)?.mem;

  useEffect(() => {
    if (!selected) {
      setDraftTitle("");
      setDraftTags("");
      setDraftContent("");
      setDirty(false);
      setConfirmMem(false);
      return;
    }
    setDraftTitle(selected.title || "");
    setDraftTags((selected.tags || []).join(", "));
    setDraftContent(selected.content || "");
    setDirty(false);
    setConfirmMem(false);
  }, [selected?.id]);

  const persist = async (next: MemoryLibrary, toastKey?: MsgKey) => {
    setSaving(true);
    try {
      const res = await saveMemoryLibrary(next);
      setLib(res.library || next);
      if (toastKey) onToast?.(t(toastKey));
      return res.library || next;
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : String(e));
      return next;
    } finally {
      setSaving(false);
    }
  };

  const patchLib = (fn: (prev: MemoryLibrary) => MemoryLibrary, toastKey?: MsgKey) => {
    if (!lib) return;
    const next = fn(lib);
    setLib(next);
    void persist(next, toastKey);
  };

  const applyDraftToLib = (prev: MemoryLibrary): MemoryLibrary => {
    if (!selected || !dirtyRef.current) return prev;
    const d = draftRef.current;
    return {
      ...prev,
      categories: prev.categories.map((c) => ({
        ...c,
        memories: c.memories.map((m) =>
          m.id === selected.id
            ? {
                ...m,
                title: d.title.trim() || t("memoryUntitled"),
                tags: parseTags(d.tags),
                content: d.content,
                updated_at: Date.now() / 1000,
              }
            : m,
        ),
      })),
    };
  };

  const flushDraft = () => {
    if (!dirtyRef.current || !lib) return;
    const next = applyDraftToLib(lib);
    setLib(next);
    void persist(next);
    setDirty(false);
  };

  const selectMemory = (id: string, nextCatId?: string) => {
    if (id !== memId) flushDraft();
    if (nextCatId && nextCatId !== catId) setCatId(nextCatId);
    setMemId(id);
  };

  const submitNewCategory = () => {
    const name = newCatName.trim();
    if (!name || !lib) return;
    const id = nid("cat");
    patchLib((prev) => ({
      ...prev,
      categories: [...applyDraftToLib(prev).categories, { id, name, memories: [] }],
    }));
    setCatId(id);
    setMemId("");
    setNewCatName("");
    setAddingCat(false);
    setQuery("");
  };

  const submitRename = () => {
    const name = renameValue.trim();
    const id = renamingId;
    setRenamingId("");
    if (!name || !id) return;
    patchLib((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => (c.id === id ? { ...c, name } : c)),
    }));
  };

  const deleteCategory = (id: string) => {
    if (!lib) return;
    if (lib.categories.length <= 1) {
      onToast?.(t("memoryKeepOneCategory"));
      setConfirmCatId("");
      return;
    }
    const rest = lib.categories.filter((c) => c.id !== id);
    patchLib(() => ({ ...lib, categories: rest }));
    setConfirmCatId("");
    setCatId(rest[0]?.id || "");
    setMemId(rest[0]?.memories[0]?.id || "");
    setSelectedIds(new Set());
  };

  const addMemory = () => {
    if (!cat) return;
    const id = nid("mem");
    const item: MemoryItem = {
      id,
      title: t("memoryUntitled"),
      content: "",
      tags: [],
      enabled: true,
      updated_at: Date.now() / 1000,
    };
    patchLib((prev) => {
      const base = applyDraftToLib(prev);
      return {
        ...base,
        categories: base.categories.map((c) =>
          c.id === cat.id ? { ...c, memories: [...c.memories, item] } : c,
        ),
      };
    });
    setDirty(false);
    setMemId(id);
    setQuery("");
    setSelectedIds(new Set());
  };

  const deleteMemory = () => {
    if (!selected) return;
    patchLib((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => ({
        ...c,
        memories: c.memories.filter((m) => m.id !== selected.id),
      })),
    }));
    setConfirmMem(false);
    const rest = visibleNotes.filter((h) => h.mem.id !== selected.id);
    setMemId(rest[0]?.mem.id || "");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(selected.id);
      return next;
    });
  };

  const toggleEnabled = (item: MemoryItem, enabled: boolean) => {
    patchLib((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => ({
        ...c,
        memories: c.memories.map((m) => (m.id === item.id ? { ...m, enabled } : m)),
      })),
    }));
  };

  const saveEditor = () => {
    if (!selected) return;
    patchLib((prev) => applyDraftToLib(prev), "memorySaved");
    setDirty(false);
  };

  const visibleIds = visibleNotes.map((h) => h.mem.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const toggleSelect = (id: string, range = false) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (range && lastClickedRef.current) {
        const a = visibleIds.indexOf(lastClickedRef.current);
        const b = visibleIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(visibleIds[i]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedRef.current = id;
    setConfirmBulk(false);
  };

  const selectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(visibleIds));
    setConfirmBulk(false);
  };

  const setSelectedEnabled = (enabled: boolean) => {
    if (selectedIds.size === 0) return;
    patchLib((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => ({
        ...c,
        memories: c.memories.map((m) => (selectedIds.has(m.id) ? { ...m, enabled } : m)),
      })),
    }));
  };

  const deleteSelected = () => {
    if (selectedIds.size === 0) return;
    patchLib((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => ({
        ...c,
        memories: c.memories.filter((m) => !selectedIds.has(m.id)),
      })),
    }));
    if (memId && selectedIds.has(memId)) setMemId("");
    setSelectedIds(new Set());
    setConfirmBulk(false);
  };

  const moveSelected = (targetCatId: string) => {
    if (!targetCatId || selectedIds.size === 0) return;
    const moving: MemoryItem[] = [];
    patchLib((prev) => {
      const categories = prev.categories.map((c) => ({
        ...c,
        memories: c.memories.filter((m) => {
          if (!selectedIds.has(m.id)) return true;
          moving.push(m);
          return false;
        }),
      }));
      return {
        ...prev,
        categories: categories.map((c) =>
          c.id === targetCatId ? { ...c, memories: [...c.memories, ...moving] } : c,
        ),
      };
    });
    setCatId(targetCatId);
    setSelectedIds(new Set());
    setQuery("");
  };

  const activeCount = (lib?.categories || []).reduce(
    (n, c) => n + c.memories.filter((m) => m.enabled).length,
    0,
  );
  const multi = selectedIds.size > 1;

  if (!lib) {
    return (
      <section className="pane memory-page">
        <p className="hint memory-page-loading">{t("memoryLoading")}</p>
      </section>
    );
  }

  return (
    <section className="pane memory-page">
      <header className="memory-page-head">
        <div className="memory-page-head-left">
          {onBack && (
            <button type="button" className="ghost memory-page-back" onClick={onBack}>
              ← {t("memoryBack")}
            </button>
          )}
          <div>
            <h2>
              <IconBook size={22} /> {t("memoryTitle")}
            </h2>
            <p>{t("memoryHint")}</p>
          </div>
        </div>
        <div className="memory-page-head-right">
          <label className="memory-search">
            <IconSearch size={16} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIds(new Set());
              }}
              placeholder={t("memorySearchAll")}
            />
            {query && (
              <button
                type="button"
                className="icon-btn memory-search-clear"
                onClick={() => setQuery("")}
                title={t("cancel")}
              >
                <IconX size={14} />
              </button>
            )}
          </label>
          <span className="memory-page-stat">{t("memoryActiveCount", String(activeCount))}</span>
        </div>
      </header>

      <div className="memory-page-body">
        <aside className="memory-col memory-col-cats">
          <div className="memory-col-head">
            <h3>{t("memoryCategories")}</h3>
          </div>
          <label className="memory-search compact">
            <IconSearch size={14} />
            <input
              value={catQuery}
              onChange={(e) => setCatQuery(e.target.value)}
              placeholder={t("memorySearchCats")}
            />
          </label>
          {filteredCats.length === 0 ? (
            <div className="memory-empty">
              <p>{t("memoryNoCats")}</p>
            </div>
          ) : (
            <ul className="memory-cat-list">
              {filteredCats.map((c) => {
                const on = c.memories.filter((m) => m.enabled).length;
                const active = c.id === cat?.id && !qPage;
                return (
                  <li key={c.id} className={active ? "active" : ""}>
                    {confirmCatId === c.id ? (
                      <div className="memory-inline-confirm">
                        <span>{t("memoryDeleteCategoryConfirm", c.name)}</span>
                        <div>
                          <button type="button" className="danger" onClick={() => deleteCategory(c.id)}>
                            {t("memoryDeleteCategory")}
                          </button>
                          <button type="button" className="ghost" onClick={() => setConfirmCatId("")}>
                            {t("cancel")}
                          </button>
                        </div>
                      </div>
                    ) : renamingId === c.id ? (
                      <form
                        className="memory-inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          submitRename();
                        }}
                      >
                        <input
                          ref={renameRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenamingId("");
                          }}
                        />
                        <button type="submit" className="icon-btn" title={t("saveMemory")}>
                          <IconCheck size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title={t("cancel")}
                          onClick={() => setRenamingId("")}
                        >
                          <IconX size={14} />
                        </button>
                      </form>
                    ) : (
                      <div className="memory-cat-row">
                        <button
                          type="button"
                          className="memory-cat-main"
                          onClick={() => {
                            flushDraft();
                            setCatId(c.id);
                            setMemId("");
                            setQuery("");
                            setSelectedIds(new Set());
                          }}
                        >
                          <strong>{c.name}</strong>
                          <em>{t("memoryCatCount", String(c.memories.length), String(on))}</em>
                        </button>
                        <div className="memory-cat-ops">
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("memoryRenameCategory")}
                            onClick={() => {
                              setRenamingId(c.id);
                              setRenameValue(c.name);
                              setConfirmCatId("");
                            }}
                          >
                            <IconPencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("memoryDeleteCategory")}
                            onClick={() => {
                              setConfirmCatId(c.id);
                              setRenamingId("");
                            }}
                          >
                            <IconTrash size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {addingCat ? (
            <form
              className="memory-inline-form memory-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitNewCategory();
              }}
            >
              <input
                ref={newCatRef}
                value={newCatName}
                placeholder={t("memoryNewCategoryPrompt")}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAddingCat(false);
                    setNewCatName("");
                  }
                }}
              />
              <button type="submit" className="primary" disabled={!newCatName.trim()}>
                {t("memoryCreate")}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setAddingCat(false);
                  setNewCatName("");
                }}
              >
                {t("cancel")}
              </button>
            </form>
          ) : (
            <button type="button" className="memory-add-btn" onClick={() => setAddingCat(true)}>
              <IconPlus size={16} /> {t("memoryNewCategory")}
            </button>
          )}
        </aside>

        <div className="memory-col memory-col-notes">
          <div className="memory-col-head">
            <h3>
              {qPage
                ? t("memorySearchResults", String(visibleNotes.length))
                : cat?.name || t("memoryCategories")}
            </h3>
            <div className="memory-col-actions">
              <button type="button" className="primary" onClick={addMemory} disabled={!cat}>
                <IconPlus size={14} /> {t("memoryNewItem")}
              </button>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="memory-bulk">
              <span className="memory-bulk-count">{t("memorySelected", String(selectedIds.size))}</span>
              <button type="button" className="ghost" onClick={() => setSelectedEnabled(true)}>
                {t("memoryOn")}
              </button>
              <button type="button" className="ghost" onClick={() => setSelectedEnabled(false)}>
                {t("memoryOff")}
              </button>
              <div className="memory-move-wrap">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setMoveOpen((v) => !v)}
                >
                  {t("memoryMove")}
                </button>
                {moveOpen && (
                  <div className="memory-move-menu">
                    {lib.categories.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          moveSelected(c.id);
                          setMoveOpen(false);
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {confirmBulk ? (
                <>
                  <span>{t("memoryBulkDeleteConfirm", String(selectedIds.size))}</span>
                  <button type="button" className="danger" onClick={deleteSelected}>
                    {t("memoryBulkDelete")}
                  </button>
                  <button type="button" className="ghost" onClick={() => setConfirmBulk(false)}>
                    {t("cancel")}
                  </button>
                </>
              ) : (
                <button type="button" className="ghost" onClick={() => setConfirmBulk(true)}>
                  {t("memoryBulkDelete")}
                </button>
              )}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setSelectedIds(new Set());
                  setMoveOpen(false);
                  setConfirmBulk(false);
                }}
              >
                {t("memoryClearSelect")}
              </button>
            </div>
          )}

          {visibleNotes.length === 0 ? (
            <div className="memory-empty">
              <p>{qPage ? t("memoryNoResults") : t("memoryEmptyCat")}</p>
              {!qPage && (
                <button type="button" className="primary" onClick={addMemory}>
                  {t("memoryNewItem")}
                </button>
              )}
            </div>
          ) : (
            <>
              {visibleNotes.length > 1 && selectedIds.size === 0 && (
                <button type="button" className="memory-select-all" onClick={selectAllVisible}>
                  {t("memorySelectAll")}
                </button>
              )}
            <ul className="memory-note-list">
              {visibleNotes.map((hit) => {
                const m = hit.mem;
                const checked = selectedIds.has(m.id);
                return (
                  <li key={m.id}>
                    <div
                      className={`memory-note-card${m.id === selected?.id ? " active" : ""}${m.enabled ? "" : " off"}${checked ? " picked" : ""}`}
                    >
                      <label className="memory-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleSelect(m.id, (e.nativeEvent as MouseEvent).shiftKey)}
                        />
                      </label>
                      <button
                        type="button"
                        className="memory-note-main"
                        onClick={(e) => {
                          if (e.shiftKey || e.metaKey || e.ctrlKey) {
                            e.preventDefault();
                            toggleSelect(m.id, e.shiftKey);
                            lastClickedRef.current = m.id;
                            return;
                          }
                          lastClickedRef.current = m.id;
                          selectMemory(m.id, hit.cat.id);
                        }}
                      >
                        <strong>{m.title || t("memoryUntitled")}</strong>
                        {qPage && (
                          <em className="memory-note-cat">{t("memoryInCat", hit.cat.name)}</em>
                        )}
                        {m.tags.length > 0 && (
                          <span className="memory-lib-tags">
                            {m.tags.map((tag) => (
                              <em key={tag}>{tag}</em>
                            ))}
                          </span>
                        )}
                        {m.content.trim() && (
                          <p>
                            {m.content.trim().slice(0, 80)}
                            {m.content.trim().length > 80 ? "…" : ""}
                          </p>
                        )}
                      </button>
                      <button
                        type="button"
                        className={`memory-inject${m.enabled ? " on" : ""}`}
                        title={m.enabled ? t("memoryOn") : t("memoryOff")}
                        onClick={() => toggleEnabled(m, !m.enabled)}
                      >
                        <span className={`memory-toggle${m.enabled ? " on" : ""}`} aria-hidden>
                          <i />
                        </span>
                        <em>{m.enabled ? t("memoryOn") : t("memoryOff")}</em>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            </>
          )}
        </div>

        <div className="memory-col memory-col-editor">
          {multi ? (
            <div className="memory-empty memory-empty-editor">
              <p>{t("memorySelected", String(selectedIds.size))}</p>
              <p className="hint">{t("memoryOn")} · {t("memoryOff")} · {t("memoryMove")}</p>
            </div>
          ) : selected ? (
            <>
              <div className="memory-col-head">
                <h3>{t("memoryEditor")}</h3>
                {confirmMem ? (
                  <div className="memory-inline-confirm tight">
                    <span>{t("memoryDeleteItemConfirm", selected.title || t("memoryUntitled"))}</span>
                    <button type="button" className="danger" onClick={deleteMemory}>
                      {t("memoryDeleteItem")}
                    </button>
                    <button type="button" className="ghost" onClick={() => setConfirmMem(false)}>
                      {t("cancel")}
                    </button>
                  </div>
                ) : (
                  <button type="button" className="ghost" onClick={() => setConfirmMem(true)}>
                    <IconTrash size={14} /> {t("memoryDeleteItem")}
                  </button>
                )}
              </div>
              <button
                type="button"
                className={`memory-inject-row${selected.enabled ? " on" : ""}`}
                onClick={() => toggleEnabled(selected, !selected.enabled)}
              >
                <span className={`memory-toggle${selected.enabled ? " on" : ""}`} aria-hidden>
                  <i />
                </span>
                <span>
                  <strong>{selected.enabled ? t("memoryOn") : t("memoryOff")}</strong>
                  <em>{t("memoryInjectHint")}</em>
                </span>
              </button>
              <div className="memory-editor-fields">
                <label>
                  {t("memoryItemTitle")}
                  <input
                    value={draftTitle}
                    onChange={(e) => {
                      setDraftTitle(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <label>
                  {t("memoryItemTags")}
                  <input
                    value={draftTags}
                    placeholder={t("memoryTagsPlaceholder")}
                    onChange={(e) => {
                      setDraftTags(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
              </div>
              <textarea
                value={draftContent}
                placeholder={t("memoryEmptyHint")}
                onChange={(e) => {
                  setDraftContent(e.target.value);
                  setDirty(true);
                }}
              />
              <div className="memory-editor-foot">
                <span className="hint">
                  {t("memoryChars", String(draftContent.length))}
                  {dirty ? ` · ${t("memoryUnsaved")}` : ""}
                  {saving ? ` · ${t("memorySaving")}` : ""}
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={saving || !dirty}
                  onClick={saveEditor}
                >
                  {t("saveMemory")}
                </button>
              </div>
            </>
          ) : (
            <div className="memory-empty memory-empty-editor">
              <p>{t("memoryPickOrCreate")}</p>
              <button type="button" className="primary" onClick={addMemory}>
                <IconPlus size={14} /> {t("memoryNewItem")}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
