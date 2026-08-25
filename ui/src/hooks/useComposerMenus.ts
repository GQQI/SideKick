import { useEffect, useMemo, useState } from "react";
import { listFiles, searchFiles, type SkillItem } from "../api";
import { atFileMenuQuery } from "../components/AtFileMenu";
import { buildSlashMenuItems, slashMenuQuery } from "../slash/commands";
import type { Locale } from "../i18n";

export type AtFileHit = {
  path: string;
  name: string;
  kind?: string;
  match?: string;
};

export function useComposerMenus(
  input: string,
  skills: SkillItem[],
  locale: Locale,
  workspacePath: string | undefined,
) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [atFileHits, setAtFileHits] = useState<AtFileHit[]>([]);
  const [atFileIndex, setAtFileIndex] = useState(0);
  const [atFileLoading, setAtFileLoading] = useState(false);

  const slashQuery = useMemo(() => slashMenuQuery(input), [input]);
  const slashItems = useMemo(
    () => (slashQuery != null ? buildSlashMenuItems(slashQuery, skills, locale) : []),
    [slashQuery, skills, locale],
  );
  const slashOpen = slashQuery != null;
  const atFileQuery = useMemo(
    () => (slashOpen ? null : atFileMenuQuery(input)),
    [input, slashOpen],
  );
  const atFileOpen = atFileQuery != null;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setAtFileIndex(0);
  }, [atFileQuery]);

  useEffect(() => {
    if (atFileQuery == null) {
      setAtFileHits([]);
      setAtFileLoading(false);
      return;
    }
    if (!workspacePath) {
      setAtFileHits([]);
      return;
    }
    let cancelled = false;
    setAtFileLoading(true);
    const q = atFileQuery.trim();
    const timer = window.setTimeout(() => {
      const run = async () => {
        try {
          if (!q) {
            const listed = await listFiles(".");
            if (cancelled) return;
            const files = (listed.entries || [])
              .filter((e) => e.type === "file")
              .slice(0, 40)
              .map((e) => ({
                path: e.path,
                name: e.name,
                kind: e.kind || "file",
              }));
            setAtFileHits(files);
            return;
          }
          const res = await searchFiles(q, ".");
          if (cancelled) return;
          const files = (res.hits || [])
            .filter((h) => h.kind !== "dir")
            .slice(0, 40)
            .map((h) => ({
              path: h.path,
              name: h.name || h.path.split("/").pop() || h.path,
              kind: h.kind,
              match: h.match,
            }));
          const seen = new Set<string>();
          const uniq = files.filter((f) => {
            if (seen.has(f.path)) return false;
            seen.add(f.path);
            return true;
          });
          setAtFileHits(uniq);
        } catch {
          if (!cancelled) setAtFileHits([]);
        } finally {
          if (!cancelled) setAtFileLoading(false);
        }
      };
      void run();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atFileQuery, workspacePath]);

  return {
    slashIndex,
    setSlashIndex,
    slashItems,
    slashOpen,
    atFileHits,
    atFileIndex,
    setAtFileIndex,
    atFileLoading,
    atFileOpen,
  };
}
