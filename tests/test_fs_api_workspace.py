from pathlib import Path

from metateam.services import fs_api


def test_workspace_root_uses_bound_path(tmp_path: Path) -> None:
    bound = tmp_path / "opened-folder"
    bound.mkdir()
    token = fs_api.bind_active_workspace(bound)
    try:
        assert fs_api.workspace_root() == bound.resolve()
        target = fs_api.safe_resolve("hello.md")
        assert target == (bound / "hello.md").resolve()
    finally:
        fs_api.reset_active_workspace(token)


def test_write_text_remaps_foreign_drive(tmp_path: Path, monkeypatch) -> None:
    from metateam.core import pathutil

    monkeypatch.setattr(pathutil, "_windows_drive_ready", lambda letter: False)
    token = fs_api.bind_active_workspace(tmp_path)
    try:
        res = fs_api.write_text("Q:/Project/hello.md", "hi", allow_outside=True)
        dest = tmp_path / "Project" / "hello.md"
        assert dest.is_file()
        assert dest.read_text(encoding="utf-8") == "hi"
        assert "hello.md" in str(res["path"]).replace("\\", "/")
    finally:
        fs_api.reset_active_workspace(token)
