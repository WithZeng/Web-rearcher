from __future__ import annotations

import asyncio


def test_import_env_text_supports_grobid_url(monkeypatch):
    from lit_researcher import config as runtime_config
    import lit_researcher.ui_helpers as ui_helpers

    saved_values: list[tuple[str, str]] = []
    monkeypatch.setattr(runtime_config, "GROBID_URL", "")
    monkeypatch.setattr(
        ui_helpers,
        "save_to_env",
        lambda key, value: saved_values.append((key, value)),
    )

    result = ui_helpers.import_env_text("GROBID_URL=http://grobid:8070\n")

    assert result["warnings"] == []
    assert "GROBID_URL" in result["imported"]
    assert runtime_config.GROBID_URL == "http://grobid:8070"
    assert ("GROBID_URL", "http://grobid:8070") in saved_values


def test_update_config_persists_grobid_url(monkeypatch):
    from lit_researcher import config as runtime_config
    import api.routes.config_routes as config_routes

    saved_values: list[tuple[str, str]] = []
    monkeypatch.setattr(runtime_config, "GROBID_URL", "")
    monkeypatch.setattr(
        config_routes,
        "save_to_env",
        lambda key, value: saved_values.append((key, value)),
    )

    response = asyncio.run(
        config_routes.update_config(
            config_routes.ConfigUpdateRequest(grobid_url="http://grobid:8070")
        )
    )

    assert response == {"ok": True}
    assert runtime_config.GROBID_URL == "http://grobid:8070"
    assert ("GROBID_URL", "http://grobid:8070") in saved_values
