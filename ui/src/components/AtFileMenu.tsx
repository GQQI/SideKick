type AtFileHit = {
  path: string;
  name: string;
  kind?: string;
  match?: string;
};

type Props = {
  items: AtFileHit[];
  activeIndex: number;
  loading?: boolean;
  emptyLabel: string;
  menuLabel: string;
  onSelect: (item: AtFileHit) => void;
  onHover: (index: number) => void;
};

/** Composer @file picker — same chrome as SlashMenu. */
export function AtFileMenu({
  items,
  activeIndex,
  loading,
  emptyLabel,
  menuLabel,
  onSelect,
  onHover,
}: Props) {
  if (loading && items.length === 0) {
    return (
      <div className="slash-menu at-file-menu" role="listbox" aria-label={menuLabel}>
        <div className="slash-empty">…</div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="slash-menu at-file-menu" role="listbox" aria-label={menuLabel}>
        <div className="slash-empty">{emptyLabel}</div>
      </div>
    );
  }
  return (
    <div className="slash-menu at-file-menu" role="listbox" aria-label={menuLabel}>
      {items.map((item, i) => (
        <button
          key={`${item.path}-${item.match || ""}`}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={`slash-item ${i === activeIndex ? "active" : ""}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
        >
          <span className="slash-item-label">{item.name}</span>
          <span className="slash-item-desc">{item.path}</span>
        </button>
      ))}
    </div>
  );
}

/** Trailing `@query` in composer (not email-like mid-word). */
export function atFileMenuQuery(input: string): string | null {
  const m = /(^|[\s\n])@([^\s@]*)$/.exec(input);
  if (!m) return null;
  return m[2] ?? "";
}

export function stripTrailingAtQuery(input: string): string {
  return input.replace(/(^|[\s\n])@[^\s@]*$/, "$1").replace(/\s+$/, "");
}
