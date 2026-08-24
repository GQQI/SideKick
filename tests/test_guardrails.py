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
    args = {"path": "./src/app.py"}
    assert g.before("read_file", args) is None
    g.after("read_file", args, "1|print('hi')")
    again = g.before("read_file", {"path": "src/app.py"})
    assert again is not None
    assert "already returned a result" in again


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


def test_mutating_tool_resets_explore_streak() -> None:
    g = Guardrails(max_explore_streak=2, same_call_ok_limit=4)
    assert g.before("read_file", {"path": "a.py"}) is None
    g.after("read_file", {"path": "a.py"}, "ok")
    assert g.before("write_file", {"path": "a.py", "content": "x"}) is None
    g.after("write_file", {"path": "a.py", "content": "x"}, "wrote a.py")
    assert g.before("read_file", {"path": "b.py"}) is None
    g.after("read_file", {"path": "b.py"}, "ok")
