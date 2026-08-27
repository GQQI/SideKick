from metateam.runtime.text_tool_calls import (
    XmlToolStream,
    extract_text_tool_calls,
    merge_text_tool_calls,
    snapshot_xml_tool_calls,
    split_before_tool_markup,
)
from metateam.runtime.tool_registry import bind_tool_args


def test_parse_qwen_function_parameter_markup() -> None:
    raw = (
        "<tool_call>\n"
        "<function=write_file>\n"
        "<parameter=path>notes/hello.md</parameter>\n"
        "<parameter=content># Hi</parameter>\n"
        "</function>\n"
        "</tool_call>"
    )
    visible, calls = extract_text_tool_calls(raw)
    assert visible == ""
    assert len(calls) == 1
    assert calls[0]["function"]["name"] == "write_file"
    assert '"path": "notes/hello.md"' in calls[0]["function"]["arguments"]


def test_parse_minimax_invoke_markup() -> None:
    raw = (
        "Let me write it.\n"
        "<minimax:tool_call>\n"
        '<invoke name="write_file">\n'
        '<parameter name="path">a.txt</parameter>\n'
        '<parameter name="content">ok</parameter>\n'
        "</invoke>\n"
        "</minimax:tool_call>"
    )
    visible, calls = extract_text_tool_calls(raw)
    assert "Let me write it." in visible
    assert "<invoke" not in visible
    assert calls[0]["function"]["name"] == "write_file"


def test_split_hides_tool_markup() -> None:
    visible, held = split_before_tool_markup("hello <function=write_file>")
    assert visible == "hello "
    assert held.startswith("<function=")


def test_merge_skips_when_structured_calls_exist() -> None:
    msg = {
        "role": "assistant",
        "content": "<function=write_file><parameter=path>x</parameter></function>",
        "tool_calls": [{"id": "1", "type": "function", "function": {"name": "list_dir", "arguments": "{}"}}],
    }
    out = merge_text_tool_calls(msg)
    assert out["tool_calls"][0]["function"]["name"] == "list_dir"


def test_snapshot_streams_partial_xml_params() -> None:
    held = (
        "<tool_call>\n"
        "<function=write_file>\n"
        "<parameter=path>a.txt</parameter>\n"
        "<parameter=content># He"
    )
    snaps = snapshot_xml_tool_calls(held)
    assert snaps[0][0] == "write_file"
    args = snaps[0][1]
    assert "a.txt" in args
    assert "# He" in args


def test_xml_tool_stream_emits_on_growth() -> None:
    stream = XmlToolStream()
    first = stream.feed("<function=codebase_find_similar>")
    assert first[0]["name"] == "codebase_find_similar"
    second = stream.feed(
        "<function=codebase_find_similar><parameter=query>auth</parameter>"
    )
    assert second
    assert "auth" in second[0]["arguments"]
    assert stream.feed(
        "<function=codebase_find_similar><parameter=query>auth</parameter>"
    ) == []


def test_bind_tool_args_drops_unknown_kwargs() -> None:
    def handler(query: str, limit: int = 12) -> str:
        return f"{query}:{limit}"

    bound = bind_tool_args(
        handler,
        {"query": "auth", "description": "find auth", "limit": 8, "_idx": 1},
    )
    assert bound == {"query": "auth", "limit": 8}
    assert handler(**bound) == "auth:8"
