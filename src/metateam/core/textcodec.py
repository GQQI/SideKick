"""Decode / encode workspace text. Default UTF-8; other codecs are caller-chosen."""

from __future__ import annotations

import codecs
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DecodedText:
    text: str
    encoding: str
    ok: bool = True
    error: str = ""

    @property
    def warning(self) -> str:
        return self.error if not self.ok else ""


def bom_encoding_of(data: bytes) -> str | None:
    """Encoding declared by a BOM, if any — not a guessed locale charset."""
    if data.startswith(b"\xff\xfe\x00\x00") or data.startswith(b"\x00\x00\xfe\xff"):
        return "utf-32"
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return "utf-16"
    if data.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    return None


def _codec_name(encoding: str | None) -> str:
    text = str(encoding or "").strip()
    return text or "utf-8"


def _lookup_error(encoding: str) -> str | None:
    try:
        codecs.lookup(encoding)
    except LookupError:
        return (
            f"unknown encoding {encoding!r}. "
            "Retry with encoding= set to a codec Python knows. "
            "Do not continue as if the file was read or written."
        )
    return None


def _decode_failure(encoding: str, exc: UnicodeDecodeError | None = None) -> str:
    detail = ""
    if exc is not None:
        detail = f" ({exc.reason} at byte {exc.start})"
    return (
        f"could not decode as {encoding}{detail}. "
        "Retry the same tool with encoding= set to another codec. "
        "Do not treat replacement text as source, and do not skip ahead."
    )


def decode_bytes(data: bytes, encoding: str | None = None) -> DecodedText:
    """UTF-8 by default. A BOM, if present, is the file's own declaration.

    Any other charset must be passed in by the caller (the model retries
    via the encoding= tool argument). This function does not guess locales.
    """
    if not data:
        chosen = _codec_name(encoding) if (encoding or "").strip() else "utf-8"
        return DecodedText("", chosen, True, "")

    requested = str(encoding or "").strip()
    if requested:
        return _decode_named(data, requested)

    bom = bom_encoding_of(data)
    if bom:
        return _decode_named(data, bom)
    return _decode_named(data, "utf-8")


def _decode_named(data: bytes, encoding: str) -> DecodedText:
    unknown = _lookup_error(encoding)
    if unknown:
        return DecodedText("", encoding, False, unknown)
    try:
        text = data.decode(encoding)
    except UnicodeDecodeError as exc:
        return DecodedText("", encoding, False, _decode_failure(encoding, exc))
    except ValueError:
        return DecodedText("", encoding, False, _decode_failure(encoding))
    return DecodedText(text, encoding, True, "")


def decode_path(path: Path, encoding: str | None = None) -> DecodedText:
    return decode_bytes(path.read_bytes(), encoding=encoding)


def encode_text(text: str, encoding: str | None = None) -> bytes:
    enc = _codec_name(encoding)
    unknown = _lookup_error(enc)
    if unknown:
        raise LookupError(unknown)
    return text.encode(enc)
