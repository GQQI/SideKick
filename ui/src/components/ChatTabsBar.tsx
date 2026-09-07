import { useRef, type WheelEvent } from "react";
import { IconFolder, IconPlus, IconX } from "./icons";
import type { MsgKey } from "../i18n";

export type ChatTabView = {
  id: string;
  title: string;
  workspaceName: string;
  running: boolean;
  active: boolean;
};

type Props = {
  t: (key: MsgKey, ...args: string[]) => string;
  tabs: ChatTabView[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
};

export function ChatTabsBar({ t, tabs, onSelect, onClose, onNewTab }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  if (tabs.length === 0) return null;

  // A horizontal strip is easy to overflow once several chats are open —
  // let the regular (vertical) mouse wheel pan it sideways too, like a
  // browser tab bar, instead of requiring a shift-scroll or a drag.
  function onWheel(e: WheelEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }

  return (
    <div className="chat-tabs-bar" role="tablist" aria-label={t("navJobs")}>
      <div className="chat-tabs-scroll" ref={scrollRef} onWheel={onWheel}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.active}
            className={`chat-tab${tab.active ? " active" : ""}${tab.running ? " running" : ""}`}
            title={`${tab.workspaceName} · ${tab.title}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.running ? (
              <span className="chat-tab-spinner" aria-hidden />
            ) : (
              <IconFolder size={12} />
            )}
            <span className="chat-tab-ws">{tab.workspaceName}</span>
            <span className="chat-tab-sep">·</span>
            <span className="chat-tab-title">{tab.title}</span>
            <span
              className="chat-tab-close"
              role="button"
              tabIndex={0}
              title={t("close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose(tab.id);
                }
              }}
            >
              <IconX size={11} />
            </span>
          </button>
        ))}
      </div>
      <button type="button" className="chat-tab-add" title={t("newChat")} onClick={onNewTab}>
        <IconPlus size={13} />
      </button>
    </div>
  );
}
