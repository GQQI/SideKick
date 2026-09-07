from __future__ import annotations

import pytest

from metateam.services.browser_sandbox import (
    coerce_navigate_target,
    sanitize_browser_url,
)


def test_sanitize_strips_markdown_junk() -> None:
    assert sanitize_browser_url("http://localhost:5173**，已在/") in {
        "http://localhost:5173",
        "http://localhost:5173/",
    }


def test_coerce_full_https() -> None:
    assert coerce_navigate_target("https://example.com/x") == "https://example.com/x"


def test_coerce_bare_domain() -> None:
    assert coerce_navigate_target("example.com") == "https://example.com"
    assert coerce_navigate_target("www.baidu.com/s?wd=1").startswith("https://www.baidu.com")


def test_coerce_localhost() -> None:
    assert coerce_navigate_target("localhost:5173") in {
        "http://localhost:5173",
        "http://localhost:5173/",
    }
    assert coerce_navigate_target("127.0.0.1:8788").startswith("http://127.0.0.1:8788")


def test_coerce_rejects_screenshot_filename() -> None:
    with pytest.raises(ValueError, match="screenshot"):
        coerce_navigate_target("real_1_top.png")
    with pytest.raises(ValueError, match="screenshot"):
        coerce_navigate_target("shot_1710000000.png")


def test_coerce_recovers_screenshot_sidecar(tmp_path, monkeypatch) -> None:
    shot_dir = tmp_path / ".sidekick" / "browser"
    shot_dir.mkdir(parents=True)
    shot = shot_dir / "real_tsinghua_top.png"
    shot.write_bytes(b"png")
    (shot_dir / "real_tsinghua_top.png.json").write_text(
        '{"url": "https://www.tsinghua.edu.cn/"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "metateam.services.workspace_store.get_active_workspace",
        lambda: {"configured": True, "path": str(tmp_path)},
    )
    assert (
        coerce_navigate_target(".sidekick/browser/real_tsinghua_top.png")
        == "https://www.tsinghua.edu.cn/"
    )


def test_coerce_recovers_screenshot_from_session(monkeypatch) -> None:
    from metateam.services.browser_sandbox import SANDBOX

    monkeypatch.setattr(SANDBOX, "last_url", lambda user_id=None: "https://www.tsinghua.edu.cn/")
    assert coerce_navigate_target("real_tsinghua_top.png") == "https://www.tsinghua.edu.cn/"


def test_coerce_empty() -> None:
    assert coerce_navigate_target("") == ""
    assert coerce_navigate_target("about:blank") == "about:blank"


def test_urls_match_ignores_slash_and_www() -> None:
    from metateam.services.browser_sandbox import urls_match

    assert urls_match("https://www.tsinghua.edu.cn/", "https://tsinghua.edu.cn")
    assert not urls_match("https://www.tsinghua.edu.cn/", "https://example.com")
