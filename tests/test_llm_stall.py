from __future__ import annotations

import threading
import time

from metateam.core.config import Settings
from metateam.runtime.llm import LLM, StreamWatchdog, _stream_timeouts


def test_stream_timeouts_from_settings() -> None:
    settings = Settings(demo_mode=True, api_key="", llm_idle_timeout=40, llm_stream_timeout=90)
    idle, total = _stream_timeouts(settings)
    assert idle == 40
    assert total == 90


def test_stream_watchdog_fires_on_idle() -> None:
    closed: list[int] = []
    watch = StreamWatchdog(lambda: closed.append(1), idle_sec=0.25, max_sec=5)
    watch.start()
    time.sleep(0.8)
    watch.stop()
    assert closed
    assert watch.reason == "idle"


def test_stream_chat_idle_stall_unblocks() -> None:
    class HangStream:
        def __init__(self) -> None:
            self._stop = threading.Event()

        def __iter__(self):
            self._stop.wait(30)
            return iter(())

        def close(self) -> None:
            self._stop.set()

    settings = Settings(
        demo_mode=True,
        api_key="",
        thinking_enabled=False,
        reasoning_effort="",
        llm_idle_timeout=1,
        llm_stream_timeout=8,
    )
    llm = LLM(settings)
    llm.demo = False
    llm.client = object()  # type: ignore[assignment]
    hang = HangStream()
    llm._create = lambda kwargs: hang  # type: ignore[method-assign]
    kinds: list[str] = []
    t0 = time.monotonic()
    for kind, _payload in llm.stream_chat([{"role": "user", "content": "hi"}]):
        kinds.append(kind)
    elapsed = time.monotonic() - t0
    assert elapsed < 6
    assert "stalled" in kinds
    assert kinds[-1] == "done"
