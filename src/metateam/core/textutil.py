"""Small text helpers shared across runtime (clipping, cleanup)."""

from __future__ import annotations


def safe_clip(text: str, limit: int, *, ellipsis: str = "…") -> str:
    """Clip text without leaving dangling markdown emphasis like ``**插``.

    Truncates on a character boundary and, when an odd number of ``**`` remains,
    backs up to the last opener so UI summaries don't end mid-bold.
    """
    raw = text or ""
    if limit <= 0:
        return ""
    if len(raw) <= limit:
        return raw
    cut = raw[:limit].rstrip()
    # Prefer breaking at a paragraph / sentence boundary near the end.
    for sep in ("\n\n", "\n", "。", "！", "？", ". ", "; ", "，", ", "):
        idx = cut.rfind(sep)
        if idx >= max(0, limit // 2):
            cut = cut[: idx + len(sep)].rstrip()
            break
    # Close or drop unfinished **bold**
    if cut.count("**") % 2 == 1:
        last = cut.rfind("**")
        if last >= 0:
            cut = cut[:last].rstrip()
    # Drop a trailing lone *
    if cut.endswith("*") and not cut.endswith("**"):
        cut = cut[:-1].rstrip()
    return cut + ellipsis
