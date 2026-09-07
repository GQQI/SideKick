/** Workspace-relative POSIX path for explorer matching. */
export function normFsPath(path: string | null | undefined): string {
  return (path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

export function relFsPath(
  path: string | null | undefined,
  workspaceAbs?: string | null,
): string {
  const n = normFsPath(path);
  const root = normFsPath(workspaceAbs);
  if (!n) return "";
  if (root && n.toLowerCase() === root.toLowerCase()) return ".";
  if (root && n.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return n.slice(root.length + 1);
  }
  return n;
}

export function sameFsPath(
  a: string | null | undefined,
  b: string | null | undefined,
  workspaceAbs?: string | null,
): boolean {
  const left = relFsPath(a, workspaceAbs);
  const right = relFsPath(b, workspaceAbs);
  return Boolean(left) && left === right;
}

export function ancestorFsDirs(
  path: string,
  workspaceAbs?: string | null,
): string[] {
  const parts = relFsPath(path, workspaceAbs)
    .split("/")
    .filter((p) => p && p !== ".");
  const out = ["."];
  for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
    out.push(parts.slice(0, i + 1).join("/"));
  }
  return out;
}
