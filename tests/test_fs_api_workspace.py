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
