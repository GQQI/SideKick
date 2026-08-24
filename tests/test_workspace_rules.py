from __future__ import annotations

from pathlib import Path

from metateam.services.workspace_rules import find_rules_file, load_workspace_rules


def test_prefers_yutianlang(tmp_path: Path) -> None:
    (tmp_path / ".yutianlang").mkdir()
    (tmp_path / ".yutianlang" / "rules.md").write_text("wolf", encoding="utf-8")
    (tmp_path / ".sidekick").mkdir()
    (tmp_path / ".sidekick" / "rules.md").write_text("sidekick", encoding="utf-8")
    found = find_rules_file(tmp_path)
    assert found is not None
    assert found.name == "rules.md"
    assert ".yutianlang" in found.as_posix()
    text = load_workspace_rules(tmp_path)
    assert "wolf" in text
    assert "sidekick" not in text
    assert "Project rules" in text


def test_falls_back_to_agents(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("team rules", encoding="utf-8")
    text = load_workspace_rules(tmp_path)
    assert "team rules" in text
    assert "AGENTS.md" in text


def test_empty_when_missing(tmp_path: Path) -> None:
    assert find_rules_file(tmp_path) is None
    assert load_workspace_rules(tmp_path) == ""


def test_truncates(tmp_path: Path) -> None:
    (tmp_path / ".sidekick").mkdir()
    (tmp_path / ".sidekick" / "rules.md").write_text("x" * 50, encoding="utf-8")
    text = load_workspace_rules(tmp_path, max_chars=40)
    assert "truncated" in text
