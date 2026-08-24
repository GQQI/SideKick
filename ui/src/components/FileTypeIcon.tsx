/** File-type badge / outline icon for explorer & chat file cards. */

type Props = {
  name: string;
  kind?: "file" | "dir" | "dir-open";
  size?: number;
};

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function FileTypeIcon({ name, kind = "file", size = 16 }: Props) {
  if (kind === "dir" || kind === "dir-open") {
    return (
      <span className={`ft-icon dir${kind === "dir-open" ? " open" : ""}`} style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3H6l1.3 1.4H13.3A1.2 1.2 0 0 1 14.5 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V4.2Z"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
      </span>
    );
  }

  const ext = extOf(name);
  const badge =
    ext === "js" || ext === "mjs" || ext === "cjs"
      ? { label: "JS", tone: "js" }
      : ext === "ts" || ext === "tsx"
        ? { label: "TS", tone: "ts" }
        : ext === "jsx"
          ? { label: "JX", tone: "js" }
          : ext === "css" || ext === "scss" || ext === "less"
            ? { label: "#", tone: "css" }
            : ext === "json"
              ? { label: "{}", tone: "json" }
              : ext === "md" || ext === "mdx"
                ? { label: "M↓", tone: "md" }
                : ext === "py"
                  ? { label: "PY", tone: "py" }
                  : ext === "vue"
                    ? { label: "V", tone: "vue" }
                    : ext === "html" || ext === "htm"
                      ? { label: "</>", tone: "html" }
                      : null;

  if (badge) {
    return (
      <span className={`ft-badge ${badge.tone}`} style={{ width: size, height: size }} title={ext}>
        {badge.label}
      </span>
    );
  }

  return (
    <span className="ft-icon file" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M4 1.5h5.2L12.5 5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function fileCardMeta(pathOrName: string) {
  const norm = pathOrName.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || norm;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { name, dir, path: norm };
}
