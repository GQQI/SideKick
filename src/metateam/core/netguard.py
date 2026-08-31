"""HTTP(S) target checks — block SSRF into loopback, link-local, and private nets."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_LOOPBACK_HOSTS = frozenset(
    {
        "localhost",
        "localhost.",
        "ip6-localhost",
        "ip6-loopback",
    }
)
_METADATA_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata.google.internal.",
        "metadata",
        "metadata.internal",
    }
)
_BLOCKED_LITERAL_HOSTS = frozenset(
    {
        "0.0.0.0",
        "::",
        "[::]",
        "0:0:0:0:0:0:0:0",
    }
)


def _as_ip(host: str) -> ipaddress._BaseAddress | None:
    text = (host or "").strip().strip("[]")
    if not text:
        return None
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        return None


def _ip_is_non_public(ip: ipaddress._BaseAddress) -> bool:
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (hasattr(ip, "is_site_local") and ip.is_site_local)
    )


def _resolve_ips(host: str) -> list[ipaddress._BaseAddress]:
    literal = _as_ip(host)
    if literal is not None:
        return [literal]
    found: list[ipaddress._BaseAddress] = []
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError, TimeoutError):
        return found
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip = _as_ip(str(sockaddr[0]))
        if ip is not None:
            found.append(ip)
    return found


def blocked_http_reason(url: str, *, allow_loopback: bool = False) -> str | None:
    """Return a short error if this http(s) URL must not be fetched, else None."""
    text = (url or "").strip()
    if not text:
        return "empty url"
    try:
        parsed = urlparse(text)
    except Exception:
        return "invalid url"
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return "only http(s) urls are allowed"
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return "url missing host"
    if host in _BLOCKED_LITERAL_HOSTS:
        return f"blocked host: {host}"
    if host in _METADATA_HOSTS:
        return f"blocked metadata host: {host}"
    if host in _LOOPBACK_HOSTS and not allow_loopback:
        return "loopback hosts are not allowed"

    ips = _resolve_ips(host)
    if not ips and _as_ip(host) is None and host not in _LOOPBACK_HOSTS:
        # Unresolvable public names are the caller's problem; do not fail closed
        # on DNS outages for normal websites.
        return None
    for ip in ips:
        if ip.is_loopback and allow_loopback:
            continue
        if _ip_is_non_public(ip):
            return f"blocked non-public address: {ip}"
    return None
