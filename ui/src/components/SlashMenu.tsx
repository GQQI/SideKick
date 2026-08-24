import type { SlashMenuItem } from "../slash/commands";
import { usePrefs } from "../prefs";

type Props = {
  items: SlashMenuItem[];
  activeIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHover: (index: number) => void;
};

export function SlashMenu({ items, activeIndex, onSelect, onHover }: Props) {
  const { t } = usePrefs();
  if (items.length === 0) {
    return (
      <div className="slash-menu" role="listbox" aria-label={t("slashMenu")}>
        <div className="slash-empty">{t("slashEmpty")}</div>
      </div>
    );
  }
  return (
    <div className="slash-menu" role="listbox" aria-label={t("slashMenu")}>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={`slash-item ${i === activeIndex ? "active" : ""} ${item.kind}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
        >
          <span className="slash-item-label">{item.label}</span>
          <span className="slash-item-desc">{item.description}</span>
        </button>
      ))}
    </div>
  );
}
