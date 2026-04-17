from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.notion as notion_routes


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(notion_routes.router, prefix="/api/notion")
    return TestClient(app)


def _parse_sse_events(raw: str) -> list[dict]:
    events: list[dict] = []
    for chunk in raw.split("\n\n"):
        line = chunk.strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if not payload:
            continue
        events.append(json.loads(payload))
    return events


def test_push_marks_duplicate_skip_dois(monkeypatch):
    marked: list[list[str]] = []

    def fake_smart_push(rows, database_id, on_progress, patch_existing):
        on_progress({"phase": "dedup", "message": "duplicate found"})
        return {
            "pushed": 0,
            "patched": 0,
            "skipped_quality": 0,
            "skipped_duplicate": 1,
            "total": len(rows),
            # Regression contract: duplicate skip DOI should still be returned for push-marking.
            "pushed_dois": ["10.1000/dup"],
        }

    monkeypatch.setattr(notion_routes, "smart_push", fake_smart_push)
    monkeypatch.setattr(
        notion_routes,
        "mark_rows_pushed",
        lambda dois: marked.append(list(dois)) or len(dois),
    )

    client = _build_client()
    response = client.post(
        "/api/notion/push",
        json={
            "rows": [{"source_doi": "10.1000/dup", "drug_name": "DOX", "_data_quality": 0.5}],
            "patch_existing": False,
        },
    )

    assert response.status_code == 200
    events = _parse_sse_events(response.text)
    assert events[-1]["skipped_duplicate"] == 1
    assert events[-1]["pushed_dois"] == ["10.1000/dup"]
    assert marked == [["10.1000/dup"]]


def test_push_marks_patched_dois(monkeypatch):
    marked: list[list[str]] = []

    def fake_smart_push(rows, database_id, on_progress, patch_existing):
        on_progress({"phase": "patching", "message": "patch existing page"})
        return {
            "pushed": 0,
            "patched": 1,
            "skipped_quality": 0,
            "skipped_duplicate": 0,
            "total": len(rows),
            # Regression contract: patched DOI should also be returned for push-marking.
            "pushed_dois": ["10.1000/patched"],
        }

    monkeypatch.setattr(notion_routes, "smart_push", fake_smart_push)
    monkeypatch.setattr(
        notion_routes,
        "mark_rows_pushed",
        lambda dois: marked.append(list(dois)) or len(dois),
    )

    client = _build_client()
    response = client.post(
        "/api/notion/push",
        json={
            "rows": [{"source_doi": "10.1000/patched", "drug_name": "DOX", "_data_quality": 0.5}],
            "patch_existing": True,
        },
    )

    assert response.status_code == 200
    events = _parse_sse_events(response.text)
    assert events[-1]["patched"] == 1
    assert events[-1]["pushed_dois"] == ["10.1000/patched"]
    assert marked == [["10.1000/patched"]]
