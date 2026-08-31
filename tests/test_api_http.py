from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from metateam.api.app import app
from metateam.services.memory import read_memory
from metateam.services.tenant_context import (
    ensure_tenant_knowledge,
    reset_user,
    set_user,
)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr("metateam.api.middleware.peer_is_loopback", lambda host: True)
    monkeypatch.setattr(
        "metateam.api.middleware.resolve_token",
        lambda token: ("default", "test"),
    )
    return TestClient(app)


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert "workspace" in body


def test_create_and_get_session(client: TestClient) -> None:
    created = client.post("/api/sessions")
    assert created.status_code == 200
    sid = created.json()["id"]
    got = client.get(f"/api/sessions/{sid}")
    assert got.status_code == 200
    assert got.json()["id"] == sid
    listed = client.get("/api/sessions")
    assert listed.status_code == 200
    client.delete(f"/api/sessions/{sid}")


def test_git_panel_ok(client: TestClient) -> None:
    r = client.get("/api/git")
    assert r.status_code == 200
    body = r.json()
    assert "is_repo" in body
    assert "files" in body


def test_memory_roundtrip_tenant_scoped(client: TestClient) -> None:
    try:
        set_user("default")
        _skills, mem = ensure_tenant_knowledge("default")
        before = read_memory(mem, max_chars=50_000)
        payload = (before + "\n\n- integration-test-marker\n").strip()
        r = client.put("/api/memory", json={"content": payload})
        assert r.status_code == 200
        got = client.get("/api/memory")
        assert got.status_code == 200
        assert "integration-test-marker" in got.json().get("content", "")
        client.put("/api/memory", json={"content": before or "# MEMORY\n"})
    finally:
        reset_user()


def test_register_forbidden_after_setup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("metateam.api.middleware.peer_is_loopback", lambda host: True)
    monkeypatch.setattr("metateam.api.routes.auth.needs_setup", lambda: False)
    client = TestClient(app)
    r = client.post(
        "/api/auth/register",
        json={"username": "newuser", "email": "new@example.com", "password": "secret1"},
    )
    assert r.status_code == 403


def test_create_user_requires_header_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("metateam.api.middleware.peer_is_loopback", lambda host: True)
    monkeypatch.setattr(
        "metateam.api.middleware.resolve_token",
        lambda token: ("default", "test") if token else None,
    )
    client = TestClient(app)
    r = client.post(
        "/api/auth/users",
        json={"username": "newuser", "email": "new@example.com", "password": "secret1"},
    )
    assert r.status_code == 401
    denied = client.get("/api/sessions?token=leaked")
    assert denied.status_code == 401
    ok = client.get("/api/sessions", headers={"X-Sidekick-Token": "ok"})
    assert ok.status_code == 200
