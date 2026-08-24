"""Load SKILL.md packages from disk."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Skill:
    name: str
    description: str
    path: Path
    body: str = ""
    _body_loaded: bool = field(default=False, repr=False)

    def read_body(self) -> str:
        """Lazy-load SKILL.md body (keeps session create fast)."""
        if self._body_loaded:
            return self.body
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError:
            self._body_loaded = True
            return self.body
        _, body = _parse_frontmatter(raw)
        self.body = body
        self._body_loaded = True
        return self.body


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Cache: skills_dir -> (fingerprint, skills)
_SKILLS_CACHE: dict[str, tuple[str, list[Skill]]] = {}


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    lines = m.group(1).splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if ":" not in line:
            i += 1
            continue
        k, v = line.split(":", 1)
        key = k.strip()
        val = v.strip()
        # YAML block scalar: description: |  / >
        if val in ("|", ">", "|-", ">-", "|+", ">+") or val.startswith("|") or val.startswith(">"):
            block: list[str] = []
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() and not nxt.startswith((" ", "\t")):
                    break
                block.append(
                    nxt[2:] if nxt.startswith("  ") else nxt.lstrip("\t") if nxt.startswith("\t") else nxt
                )
                i += 1
            meta[key] = "\n".join(block).strip()
            continue
        meta[key] = val.strip("\"'")
        i += 1
    return meta, m.group(2).lstrip("\n")


def _read_skill_head(path: Path) -> tuple[dict[str, str], bool]:
    """Parse frontmatter without loading the full skill body when possible.

    Returns (meta, fully_read) — if fully_read, caller may also have body via a second read.
    """
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            chunks: list[str] = []
            dashes = 0
            total = 0
            while total < 64_000:
                line = f.readline()
                if not line:
                    break
                chunks.append(line)
                total += len(line)
                if line.strip() == "---":
                    dashes += 1
                    if dashes >= 2:
                        break
            head = "".join(chunks)
    except OSError:
        return {}, False

    if dashes >= 2:
        meta, _ = _parse_frontmatter(head + "\n")
        return meta, False

    # No proper frontmatter fence — fall back to full file for meta only
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return {}, False
    meta, _ = _parse_frontmatter(raw)
    return meta, False


def _skills_fingerprint(skills_dir: Path) -> str:
    """Cheap invalidation key: count + latest mtime of SKILL.md files."""
    latest = 0.0
    count = 0
    try:
        for p in skills_dir.rglob("SKILL.md"):
            count += 1
            try:
                latest = max(latest, p.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        return "0:0"
    return f"{count}:{latest:.6f}"


def load_skills(skills_dir: Path, *, with_body: bool = False) -> list[Skill]:
    """Load skill packages. Bodies are lazy by default for fast session create."""
    if not skills_dir.exists():
        return []

    key = str(skills_dir.resolve())
    fp = _skills_fingerprint(skills_dir)
    cached = _SKILLS_CACHE.get(key)
    if cached and cached[0] == fp:
        skills = cached[1]
        if with_body:
            for s in skills:
                s.read_body()
        return skills

    skills: list[Skill] = []
    for path in sorted(skills_dir.rglob("SKILL.md")):
        meta, _ = _read_skill_head(path)
        name = meta.get("name") or path.parent.name
        desc = meta.get("description") or ""
        if len(desc) > 80:
            desc = desc[:77] + "..."
        sk = Skill(name=name, description=desc, path=path, body="")
        if with_body:
            sk.read_body()
        skills.append(sk)

    # Prefer unique names; first wins
    seen: set[str] = set()
    uniq: list[Skill] = []
    for s in skills:
        if s.name in seen:
            continue
        seen.add(s.name)
        uniq.append(s)

    _SKILLS_CACHE[key] = (fp, uniq)
    return uniq


def get_skill(skills: list[Skill], name: str) -> Optional[Skill]:
    name = name.strip()
    for s in skills:
        if s.name == name:
            return s
    return None
