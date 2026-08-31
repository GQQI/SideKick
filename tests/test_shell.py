from __future__ import annotations

import os
from pathlib import Path

from metateam.runtime.shell_policy import (
    has_noninteractive_flags,
    is_dangerous_shell,
    is_long_running_command,
    looks_interactive_scaffold,
    strip_output_tail_filter,
)
from metateam.services.shell_sandbox import ShellSandboxPolicy, check_command


def test_long_running() -> None:
    assert is_long_running_command("npm run dev")
    assert is_long_running_command("python -m http.server 8000")
    assert not is_long_running_command("npm test")


def test_interactive_scaffold() -> None:
    assert looks_interactive_scaffold("npm create vue@latest app")
    assert not has_noninteractive_flags("npm create vue@latest app")
    assert has_noninteractive_flags("npm create vue@latest app -- --default")
    assert has_noninteractive_flags("npm create vite@latest app -- --template vue")


def test_dangerous_shell() -> None:
    assert is_dangerous_shell("rm -rf /")
    assert is_dangerous_shell("Remove-Item -Recurse C:\\")
    assert not is_dangerous_shell("Remove-Item -Path .\\login-page -Recurse -Force")
    assert not is_dangerous_shell("pytest -q")


def test_strip_tail_filter() -> None:
    cmd, stripped = strip_output_tail_filter("npm run build | Select-Object -Last 40")
    assert stripped
    assert cmd == "npm run build"
    same, flag = strip_output_tail_filter("npm test")
    assert not flag
    assert same == "npm test"


def test_check_command_empty(tmp_path: Path) -> None:
    policy = ShellSandboxPolicy.for_workspace(tmp_path)
    assert check_command("", cwd=tmp_path, policy=policy)
    assert check_command("echo hi", cwd=tmp_path, policy=policy) is None


def test_check_command_cd_dotdot(tmp_path: Path) -> None:
    policy = ShellSandboxPolicy.for_workspace(tmp_path)
    err = check_command("cd ..", cwd=tmp_path, policy=policy)
    assert err is not None
    assert "path escape" in err


def test_check_command_masks_urls(tmp_path: Path) -> None:
    policy = ShellSandboxPolicy.for_workspace(tmp_path)
    assert check_command("curl https://example.com/path", cwd=tmp_path, policy=policy) is None


def test_check_command_blocks_outside(tmp_path: Path) -> None:
    policy = ShellSandboxPolicy.for_workspace(tmp_path)
    if os.name == "nt":
        err = check_command(
            r"type C:\Windows\System32\drivers\etc\hosts",
            cwd=tmp_path,
            policy=policy,
        )
    else:
        err = check_command("cat /etc/passwd", cwd=tmp_path, policy=policy)
    assert err is not None
    assert "outside allowlist" in err
