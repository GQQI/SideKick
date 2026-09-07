from __future__ import annotations

from metateam.runtime.context import (
    COMPACTION_MARK,
    cheap_compact,
    compress_messages,
    current_turn_start,
    ensure_fit,
    extract_durable_pins,
    messages_tokens,
)


def _tool(name: str, content: str) -> dict:
    return {"role": "tool", "name": name, "content": content}


def test_cheap_compact_trims_old_tool_dumps() -> None:
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "open tsinghua"},
        _tool("read_file", "1|hello\n… lines 1-136 of 200\n" + ("X" * 8000)),
        _tool("browser_get_page_content", "Y" * 5000),
    ]
    out, did = cheap_compact(msgs, old_cap=400, recent_cap=800, recent_tools=1)
    assert did
    assert out[2]["content"].startswith("[cleared tool result:")
    assert "lines 1-136 of 200" in out[2]["content"]
    assert "read_file" in out[2]["content"]
    assert len(out[3]["content"]) < 900
    assert "open tsinghua" in out[1]["content"]


def test_current_turn_start_skips_internal_and_compaction() -> None:
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "第一轮任务"},
        {"role": "assistant", "content": "done"},
        {"role": "user", "content": f"{COMPACTION_MARK}\nsummary"},
        {"role": "user", "content": "hint", "sidekick_internal": True},
        {"role": "user", "content": "修改tsinghua.html"},
        _tool("read_file", "1|<html>… lines 1-400 of 468"),
    ]
    assert current_turn_start(msgs) == 5


def test_cheap_compact_never_clears_active_turn_reads() -> None:
    big_read = "1|<html>\n" + ("X" * 8000) + "\n… lines 1-400 of 468"
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "旧任务"},
        _tool("read_file", "old " * 800),  # previous turn — may be stubbed
        {"role": "user", "content": "修改tsinghua.html"},
        _tool("read_file", big_read),  # active turn — must stay intact
        _tool("read_file", "401|<body>\n" + "Y" * 5000 + "\n… lines 401-468 of 468"),
    ]
    out, did = cheap_compact(
        msgs, old_cap=400, recent_cap=600, recent_tools=0,
        protect_from=current_turn_start(msgs),
    )
    assert did
    # Previous turn's dump was stubbed…
    assert out[2]["content"].startswith("[cleared tool result:")
    # …but the active turn's reads are byte-identical.
    assert out[4]["content"] == big_read
    assert "Y" * 5000 in out[5]["content"]


def test_extract_pins_keeps_user_and_url() -> None:
    msgs = [
        {"role": "user", "content": "打开清华大学官网并截图"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "function": {
                        "name": "browser_navigate",
                        "arguments": '{"url": "https://www.tsinghua.edu.cn/"}',
                    }
                }
            ],
        },
        _tool("browser_navigate", '{"url": "https://www.tsinghua.edu.cn/"}'),
    ]
    pins = extract_durable_pins(msgs)
    assert "打开清华大学官网并截图" in pins
    assert "https://www.tsinghua.edu.cn/" in pins


def test_ensure_fit_single_llm_pass() -> None:
    calls = {"n": 0}

    class FakeLLM:
        def complete_text(self, system: str, user: str, temperature: float = 0.1) -> str:
            calls["n"] += 1
            return "## Goal\nkeep going\n## Next\ncontinue"

    msgs = [{"role": "system", "content": "sys"}]
    for i in range(12):
        msgs.append({"role": "user", "content": f"task {i} " + "重要约束不要忘记 " * 40})
        msgs.append(_tool("read_file", ("file contents %d " % i) * 400))
    before = messages_tokens(msgs)
    out, meta = ensure_fit(
        msgs,
        context_limit=max(3000, before // 3),
        keep_recent_tokens=800,
        trigger_ratio=0.7,
        max_attempts=3,
        llm=FakeLLM(),
    )
    assert calls["n"] <= 1
    assert meta.get("compressed")
    joined = "\n".join(str(m.get("content") or "") for m in out)
    assert "重要约束不要忘记" in joined


def test_compress_merges_prior_pins() -> None:
    prior = (
        f"{COMPACTION_MARK}\n\n## Pinned (do not drop)\n### User requests\n"
        "- 第一轮目标：部署到内网\n\n## Working memory\n## Goal\nold"
    )
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": prior},
        {"role": "user", "content": "继续，别忘了内网"},
        _tool("list_dir", ("index.html and more files " * 80)),
        _tool("read_file", "old dump " * 200),
    ]
    out, summary, did, dropped = compress_messages(
        msgs,
        context_limit=400,
        keep_recent_tokens=80,
        trigger_ratio=0.5,
        llm=None,
        prior_summary="",
    )
    assert did
    blob = "\n".join(str(m.get("content") or "") for m in out)
    assert "部署到内网" in blob or "内网" in blob
    assert summary
    assert isinstance(dropped, list)


def test_ensure_fit_archives_dropped_messages_for_display() -> None:
    """Whole turns removed from the working set must survive for the UI/disk transcript."""
    msgs = [{"role": "system", "content": "sys"}]
    markers = []
    for i in range(40):
        marker = f"UNIQUE-MARKER-{i}-别忘记这条早期消息"
        markers.append(marker)
        msgs.append({"role": "user", "content": marker + " " + ("补充内容 " * 60)})
        msgs.append({"role": "assistant", "content": "收到 " + ("处理详情 " * 60)})
    out, meta = ensure_fit(
        msgs,
        context_limit=6000,
        keep_recent_tokens=1500,
        trigger_ratio=0.6,
        max_attempts=1,
        llm=None,
    )
    dropped = meta.get("dropped_messages") or []
    assert dropped, "compaction must report what it removed from the working set"
    # Every dropped message must be a real, whole message (not a lossy stub).
    dropped_blob = "\n".join(str(m.get("content") or "") for m in dropped)
    kept_blob = "\n".join(str(m.get("content") or "") for m in out)
    # At least the earliest turns should show up only in the archive, not in
    # the shrunk working set — proving they were archived rather than deleted.
    assert any(mk in dropped_blob for mk in markers[:3])
    assert len(dropped_blob) > 0
    assert kept_blob
