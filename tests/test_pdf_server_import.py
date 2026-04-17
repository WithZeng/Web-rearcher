from __future__ import annotations

import asyncio
from pathlib import Path
import shutil
import uuid

import pytest

TEST_TEMP_ROOT = Path(__file__).resolve().parents[1] / "tests-runtime" / "pdf-server"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def _make_runtime_dir() -> Path:
    path = TEST_TEMP_ROOT / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path

def test_list_server_pdfs_only_returns_pdfs(monkeypatch):
    from lit_researcher import config as runtime_config
    from lit_researcher.pdf_import import list_server_pdfs

    runtime_dir = _make_runtime_dir()
    try:
        pdf_root = runtime_dir / "pdfs"
        pdf_root.mkdir()
        (pdf_root / "one.pdf").write_bytes(b"%PDF-1.4 fake")
        (pdf_root / "two.txt").write_text("ignore", encoding="utf-8")
        nested = pdf_root / "nested"
        nested.mkdir()
        (nested / "three.pdf").write_bytes(b"%PDF-1.4 fake 2")

        monkeypatch.setattr(runtime_config, "PDF_CACHE_DIR", pdf_root)

        entries = list_server_pdfs()

        assert {entry.path for entry in entries} == {"one.pdf", "nested/three.pdf"}
        assert all(entry.name.endswith(".pdf") for entry in entries)
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


def test_load_server_pdf_inputs_rejects_escape(monkeypatch):
    from lit_researcher import config as runtime_config
    from lit_researcher.pdf_import import load_server_pdf_inputs

    runtime_dir = _make_runtime_dir()
    try:
        pdf_root = runtime_dir / "pdfs"
        pdf_root.mkdir()
        monkeypatch.setattr(runtime_config, "PDF_CACHE_DIR", pdf_root)

        with pytest.raises(ValueError):
            load_server_pdf_inputs(["../secret.pdf"])
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


def test_load_server_pdf_inputs_reads_selected_files(monkeypatch):
    from lit_researcher import config as runtime_config
    from lit_researcher.pdf_import import load_server_pdf_inputs

    runtime_dir = _make_runtime_dir()
    try:
        pdf_root = runtime_dir / "pdfs"
        pdf_root.mkdir()
        sample = pdf_root / "sample.pdf"
        sample.write_bytes(b"%PDF-1.4 sample")
        monkeypatch.setattr(runtime_config, "PDF_CACHE_DIR", pdf_root)

        files = load_server_pdf_inputs(["sample.pdf"])

        assert files == [("sample.pdf", b"%PDF-1.4 sample")]
    finally:
        shutil.rmtree(runtime_dir, ignore_errors=True)


def test_pipeline_server_pdfs_route(monkeypatch):
    import api.routes.pipeline as pipeline_routes

    monkeypatch.setattr(
        pipeline_routes,
        "list_server_pdfs",
        lambda: [
            type("Entry", (), {
                "path": "sample.pdf",
                "name": "sample.pdf",
                "size": 123,
                "modified_at": "2026-04-18T00:00:00+00:00",
            })()
        ],
    )

    result = asyncio.run(pipeline_routes.pipeline_server_pdfs())

    assert len(result) == 1
    assert result[0].path == "sample.pdf"


def test_pipeline_pdf_server_starts_task(monkeypatch):
    import api.routes.pipeline as pipeline_routes

    captured: dict[str, object] = {}

    monkeypatch.setattr(
        pipeline_routes,
        "load_server_pdf_inputs",
        lambda paths: [("server.pdf", b"%PDF-1.4")],
    )

    def fake_start_pdf_task(*, files, mode, llm_concurrency):
        captured["files"] = files
        captured["mode"] = mode
        captured["llm_concurrency"] = llm_concurrency
        return "task-123"

    monkeypatch.setattr(pipeline_routes, "start_pdf_task", fake_start_pdf_task)

    response = asyncio.run(
        pipeline_routes.pipeline_pdf_server(
            pipeline_routes.ServerPdfImportRequest(
                paths=["server.pdf"],
                mode="multi",
                llm_concurrency=4,
            )
        )
    )

    assert response.task_id == "task-123"
    assert captured["files"] == [("server.pdf", b"%PDF-1.4")]
    assert captured["mode"] == "multi"
    assert captured["llm_concurrency"] == 4
