from __future__ import annotations

from metateam.core.guardrails import Guardrails, looks_failed


def test_looks_failed() -> None:
    assert looks_failed("ERROR: nope")
    assert looks_failed('{"error": "x"}')
    assert looks_failed("Traceback (most recent call last):")
    assert not looks_failed("wrote src/a.py (12 chars)")


def test_repeat_fail_blocks() -> None:
    g = Guardrails(same_call_fail_limit=2, same_call_ok_limit=1, max_explore_streak=8)
    args = {"path": "a.py"}
    assert g.before("read_file", args) is None
    g.after("read_file", args, "ERROR: missing")
    assert g.before("read_file", args) is None
    g.after("read_file", args, "ERROR: missing")
    blocked = g.before("read_file", args)
    assert blocked is not None
    assert "blocked repeated failing" in blocked


def test_identical_ok_explore_not_repeated() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args = {"path": "./src"}
    assert g.before("list_dir", args) is None
    g.after("list_dir", args, "file\tapp.py")
    again = g.before("list_dir", {"path": "src"})
    assert again is not None
    assert "already returned a result" in again


def test_read_file_identical_reread_allowed() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args = {"path": "tsinghua.html", "offset": 193, "limit": 0}
    assert g.before("read_file", args) is None
    g.after("read_file", args, "193|<body>\n… lines 193-468 of 468")
    # Same slice may be fetched again (Claude: re-read if you still need it).
    assert g.before("read_file", args) is None


def test_read_file_counts_as_explore_streak() -> None:
    g = Guardrails(max_explore_streak=2, same_call_ok_limit=4)
    for i, path in enumerate(("a.py", "b.py")):
        assert g.before("read_file", {"path": path}) is None
        g.after("read_file", {"path": path}, f"{i}|ok")
    blocked = g.before("list_dir", {"path": "."})
    assert blocked is not None
    assert "explore streak" in blocked


def test_explore_only_skips_streak() -> None:
    g = Guardrails(max_explore_streak=2, same_call_ok_limit=8)
    g.set_explore_only(True)
    for path in ("a.py", "b.py", "c.py"):
        assert g.before("read_file", {"path": path}) is None
        g.after("read_file", {"path": path}, "ok")
    assert g.before("list_dir", {"path": "."}) is None


def test_parallel_inflight_same_args_not_blocked() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args = {"query": "needle", "path": "."}
    assert g.before("search_text", args) is None
    # Second call still in-flight (no after yet) — parallel batch.
    assert g.before("search_text", args) is None
    g.after("search_text", args, "src/a.py:1:needle")
    g.after("search_text", args, "src/a.py:1:needle")
    # After success, a later identical call is still blocked.
    again = g.before("search_text", args)
    assert again is not None
    assert "already returned a result" in again


def test_identical_ok_browser_navigate_not_repeated() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args = {"url": "https://www.tsinghua.edu.cn/"}
    assert g.before("browser_navigate", args) is None
    g.after("browser_navigate", args, '{"url": "https://www.tsinghua.edu.cn/"}')
    again = g.before("browser_navigate", args)
    assert again is not None
    assert "already returned" in again


def test_parallel_browser_navigate_blocked() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args = {"url": "https://example.com"}
    assert g.before("browser_navigate", args) is None
    blocked = g.before("browser_navigate", args)
    assert blocked is not None
    assert "already running" in blocked


def test_dedup_read_full_coverage_serves_stub() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "src/app.css", "offset": 110, "limit": 90}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "110|a\n…\n… lines 110-199 of 400")
    # Fully-contained re-read: serve a short stub instead of duplicate bytes.
    args2 = {"path": "src/app.css", "offset": 140, "limit": 60}
    assert g.before("read_file", args2) is None
    served, adjusted = g.dedup_read("read_file", args2)
    assert served is not None
    assert served.startswith("[already in context]")
    assert "110-199" in served
    assert adjusted is None


def test_dedup_read_head_overlap_narrows_to_new_lines() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "tsinghua.html", "offset": 1, "limit": 136}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|<html>\n… lines 1-136 of 468")
    # Request 40-200: head 40-136 is already in context → serve only 137-200.
    args2 = {"path": "tsinghua.html", "offset": 40, "limit": 161}
    served, adjusted = g.dedup_read("read_file", args2)
    assert served is None
    assert adjusted is not None
    assert adjusted["offset"] == 137
    assert adjusted["limit"] == 64


def test_dedup_read_new_range_untouched() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "src/app.css", "offset": 1, "limit": 100}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|a\n… lines 1-100 of 400")
    # Genuinely new lines: run as-is.
    args2 = {"path": "src/app.css", "offset": 101, "limit": 100}
    assert g.before("read_file", args2) is None
    served, adjusted = g.dedup_read("read_file", args2)
    assert served is None
    assert adjusted is None


def test_dedup_read_entire_file_says_stop() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "tsinghua.html", "offset": 1, "limit": 0}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|<html>\n… lines 1-468 of 468")
    served, adjusted = g.dedup_read("read_file", {"path": "tsinghua.html", "offset": 330})
    assert adjusted is None
    assert served is not None
    assert "ENTIRE file" in served
    assert "stop" in served


def test_dedup_read_repeat_escalates_to_error() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "tsinghua.html", "offset": 1, "limit": 0}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|<html>\n… lines 1-468 of 468")
    repeat = {"path": "tsinghua.html", "offset": 330}
    served1, _ = g.dedup_read("read_file", repeat)
    assert served1 is not None and served1.startswith("[already in context]")
    served2, _ = g.dedup_read("read_file", repeat)
    assert served2 is not None and served2.startswith("ERROR:")
    assert "search_text" in served2


def test_dedup_read_no_limit_uses_known_total() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "notes.md", "offset": 1, "limit": 0}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|a\n… lines 1-400 of 400")
    # No limit given, but we know total=400, so this is a full subset.
    args2 = {"path": "notes.md", "offset": 200, "limit": 0}
    served, adjusted = g.dedup_read("read_file", args2)
    assert served is not None
    assert served.startswith("[already in context]")
    assert adjusted is None


def test_read_file_range_cleared_after_mutation() -> None:
    g = Guardrails(same_call_ok_limit=1, max_explore_streak=8)
    args1 = {"path": "src/app.css", "offset": 1, "limit": 200}
    assert g.before("read_file", args1) is None
    g.after("read_file", args1, "1|a\n… lines 1-200 of 200")
    assert g.before("write_file", {"path": "src/app.css", "content": "x"}) is None
    g.after("write_file", {"path": "src/app.css", "content": "x"}, "wrote src/app.css")
    # File changed — the old coverage must not dedupe the fresh read.
    args2 = {"path": "src/app.css", "offset": 50, "limit": 50}
    assert g.before("read_file", args2) is None
    served, adjusted = g.dedup_read("read_file", args2)
    assert served is None
    assert adjusted is None


def test_mutating_tool_resets_explore_streak() -> None:
    g = Guardrails(max_explore_streak=2, same_call_ok_limit=4)
    assert g.before("read_file", {"path": "a.py"}) is None
    g.after("read_file", {"path": "a.py"}, "ok")
    assert g.before("write_file", {"path": "a.py", "content": "x"}) is None
    g.after("write_file", {"path": "a.py", "content": "x"}, "wrote a.py")
    assert g.before("read_file", {"path": "b.py"}) is None
    g.after("read_file", {"path": "b.py"}, "ok")
