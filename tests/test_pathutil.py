from __future__ import annotations

import os
from pathlib import Path

import pytest

from metateam.core.pathutil import is_relative_to, relative_to_posix, resolve_path


def test_relative_child(tmp_path: Path) -> None:
    child = tmp_path / "a" / "b.txt"
    child.parent.mkdir()
    child.write_text("x", encoding="utf-8")
    assert is_relative_to(child, tmp_path)
    assert relative_to_posix(child, tmp_path) == "a/b.txt"


def test_root_is_relative_to_itself(tmp_path: Path) -> None:
    assert is_relative_to(tmp_path, tmp_path)
    assert relative_to_posix(tmp_path, tmp_path) == "."


def test_outside_path_rejected(tmp_path: Path) -> None:
    other = tmp_path.parent / f"not-{tmp_path.name}"
    other.mkdir(exist_ok=True)
    assert not is_relative_to(other, tmp_path)
    with pytest.raises(ValueError, match="outside workspace"):
        relative_to_posix(other, tmp_path)


@pytest.mark.skipif(os.name != "nt", reason="Windows case folding")
def test_windows_case_insensitive(tmp_path: Path) -> None:
    child = tmp_path / "nested" / "File.TXT"
    child.parent.mkdir()
    child.write_text("x", encoding="utf-8")
    upper_root = Path(str(tmp_path.resolve()).upper())
    assert is_relative_to(child, upper_root)
    assert relative_to_posix(child, tmp_path).replace("\\", "/").lower() == "nested/file.txt"


def test_resolve_path_expands(tmp_path: Path) -> None:
    p = resolve_path(tmp_path / ".")
    assert p.is_absolute()
