from __future__ import annotations

from metateam.services.model_config import (
    ModelEntry,
    ModelProvider,
    ModelRef,
    ModelSetup,
    _pick_model_setup,
)


def _setup(main_id: str, key: str, provider_id: str = "p1") -> ModelSetup:
    return ModelSetup(
        providers=[
            ModelProvider(
                id=provider_id,
                name="demo",
                models=[ModelEntry(id=main_id, name="m", api_key=key, base_url="http://x")],
            )
        ],
        main=ModelRef(provider_id=provider_id, model_id=main_id),
    )


def test_pick_model_setup_prefers_workspace_when_main_has_key() -> None:
    ws = _setup("ws", "sk-ws")
    acct = _setup("acct", "sk-acct")
    picked = _pick_model_setup(ws, acct)
    assert picked.resolve(picked.main)[3] == "sk-ws"


def test_pick_model_setup_falls_back_to_account_when_workspace_is_demo() -> None:
    ws = _setup("ws", "")
    acct = _setup("acct", "sk-acct")
    picked = _pick_model_setup(ws, acct)
    assert picked.resolve(picked.main)[3] == "sk-acct"


def test_find_entry_matches_without_provider_id() -> None:
    setup = _setup("mdl_1", "sk-1", provider_id="prov_a")
    setup.main = ModelRef(provider_id="", model_id="mdl_1")
    prov, entry = setup.find_entry(setup.main)
    assert entry is not None
    assert entry.api_key == "sk-1"
    assert prov is not None
