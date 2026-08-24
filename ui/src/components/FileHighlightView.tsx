import { useEffect, useMemo, useRef, type ReactNode, type UIEvent } from "react";

type Props = {
  content: string;
  query: string;
  focusLine?: number;
};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightLine(line: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return line;
  try {
    const re = new RegExp(escapeRegExp(q), "gi");
    const nodes: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) nodes.push(line.slice(last, m.index));
      nodes.push(
        <mark key={`m${i++}`} className="search-mark">
          {m[0]}
        </mark>,
      );
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    if (last < line.length) nodes.push(line.slice(last));
    return nodes.length ? nodes : line;
  } catch {
    return line;
  }
}

export function countTextLines(content: string): number {
  if (!content) return 0;
  const parts = content.split(/\r?\n/);
  return parts.length;
}

export function FileHighlightView({ content, query, focusLine = 0 }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split(/\r?\n/), [content]);

  useEffect(() => {
    if (!focusLine || focusLine < 1) return;
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-line="${focusLine}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusLine, content, query]);

  return (
    <div className="file-highlight" ref={rootRef}>
      <div className="file-highlight-inner">
        {lines.map((line, idx) => {
          const n = idx + 1;
          const active = focusLine > 0 && n === focusLine;
          return (
            <div
              key={n}
              data-line={n}
              className={`file-highlight-line${active ? " active" : ""}`}
            >
              <span className="file-highlight-no">{n}</span>
              <code className="file-highlight-code">{highlightLine(line, query)}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type EditorProps = {
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
};

export function FileTextEditor({ value, readOnly, onChange }: EditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, countTextLines(value));
  const numbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1),
    [lineCount],
  );

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const gutter = gutterRef.current;
    if (gutter) gutter.scrollTop = e.currentTarget.scrollTop;
  };

  return (
    <div className="file-editor">
      <div className="file-editor-gutter" ref={gutterRef} aria-hidden>
        {numbers.map((n) => (
          <div key={n} className="file-editor-no">
            {n}
          </div>
        ))}
      </div>
      <textarea
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onScroll={onScroll}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
