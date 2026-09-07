from __future__ import annotations

from pathlib import Path

from metateam.runtime.tool_registry import skill_tool_name
from metateam.services.skills import (
    compose_skill_markdown,
    delete_skill,
    find_skill,
    import_skill_dir,
    import_skill_markdown,
    validate_skill_text,
    write_skill,
)


def test_skill_tool_name_visio() -> None:
    assert skill_tool_name("visio-skill") == "skill_visio_skill"
    assert skill_tool_name("oracle-db") == "skill_oracle_db"


def test_validate_requires_name_and_steps() -> None:
    bad = validate_skill_text("just some notes")
    assert not bad["ok"]
    ok = validate_skill_text(
        compose_skill_markdown(
            "demo-report",
            "Use when drafting a short status report.",
            "# Demo\n\n## Steps\n1. Collect facts\n2. Write the report\n",
        )
    )
    assert ok["ok"]
    assert ok["name"] == "demo-report"


def test_write_import_delete(tmp_path: Path) -> None:
    body = "# Demo\n\n## Steps\n1. Do the work\n2. Report back\n"
    sk = write_skill(
        tmp_path,
        name="My Skill",
        description="Use when the user asks for a canned workflow.",
        content=body,
    )
    assert sk.name == "my-skill"
    assert (tmp_path / "my-skill" / "SKILL.md").is_file()
    assert find_skill(tmp_path, "my-skill") is not None

    again = compose_skill_markdown(
        "other-skill",
        "Use when importing a second skill package.",
        body,
    )
    imported = import_skill_markdown(tmp_path, again)
    assert imported.name == "other-skill"
    assert delete_skill(tmp_path, "my-skill") == "my-skill"
    assert find_skill(tmp_path, "my-skill") is None


def test_import_fallback_name(tmp_path: Path) -> None:
    text = """---
description: Use this helper when summarizing meeting notes into bullets.
---

# Notes

## Steps
1. Read the notes
2. Return bullets
"""
    sk = import_skill_markdown(tmp_path, text, fallback_name="meeting-notes")
    assert sk.name == "meeting-notes"


def test_import_skill_dir_keeps_scripts(tmp_path: Path) -> None:
    src = tmp_path / "dameng-db"
    src.mkdir()
    (src / "SKILL.md").write_text(
        compose_skill_markdown(
            "dameng-db",
            "Use when querying a Dameng database offline.",
            "# Dameng\n\n## Steps\n1. Connect\n2. Run SQL\n",
        ),
        encoding="utf-8",
    )
    (src / "scripts").mkdir()
    (src / "scripts" / "db_exec.py").write_text("print('ok')\n", encoding="utf-8")
    dest = tmp_path / "installed"
    dest.mkdir()
    imported = import_skill_dir(dest, src)
    assert imported[0].name == "dameng-db"
    assert (dest / "dameng-db" / "scripts" / "db_exec.py").is_file()


def test_sync_workspace_skill_installs_package(tmp_path: Path) -> None:
    from metateam.services.skills import find_skill, sync_workspace_skill

    ws = tmp_path / "workspace"
    lib = tmp_path / "library"
    pkg = ws / "demo-pack"
    pkg.mkdir(parents=True)
    lib.mkdir()
    md = pkg / "SKILL.md"
    md.write_text(
        compose_skill_markdown(
            "demo-pack",
            "Use when testing skill library sync from a workspace folder.",
            "# Demo\n\n## Steps\n1. Run the helper\n2. Report\n",
        ),
        encoding="utf-8",
    )
    (pkg / "scripts").mkdir()
    (pkg / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
    note = sync_workspace_skill(md, ws, lib)
    assert "demo-pack" in note
    assert find_skill(lib, "demo-pack") is not None
    assert (lib / "demo-pack" / "scripts" / "run.py").is_file()


def test_sync_workspace_skill_ignores_ordinary_files(tmp_path: Path) -> None:
    from metateam.services.skills import sync_workspace_skill

    ws = tmp_path / "workspace"
    lib = tmp_path / "library"
    ws.mkdir()
    lib.mkdir()
    notes = ws / "notes.md"
    notes.write_text("# just notes\n", encoding="utf-8")
    assert sync_workspace_skill(notes, ws, lib) == ""
