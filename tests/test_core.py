"""Unit tests for core pipeline functions."""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import patch, AsyncMock

import aiohttp
import pytest

# ── search.py tests ──────────────────────────────────────────────────────────


def test_merge_and_deduplicate_merges_fields():
    from lit_researcher.search import _merge_and_deduplicate

    papers = [
        {"doi": "10.1/a", "title": "Paper A", "abstract": "", "pdf_url": "http://pdf.com/a.pdf"},
        {"doi": "10.1/a", "title": "Paper A", "abstract": "A long abstract here", "pdf_url": None},
    ]
    result = _merge_and_deduplicate(papers)
    assert len(result) == 1
    assert result[0]["pdf_url"] == "http://pdf.com/a.pdf"
    assert result[0]["abstract"] == "A long abstract here"


def test_merge_and_deduplicate_title_fallback():
    from lit_researcher.search import _merge_and_deduplicate

    papers = [
        {"doi": "", "title": "Same Title", "abstract": "abs1"},
        {"doi": "", "title": "Same Title", "abstract": "abs2 longer"},
    ]
    result = _merge_and_deduplicate(papers)
    assert len(result) == 1
    assert result[0]["abstract"] == "abs2 longer"


def test_merge_and_deduplicate_no_key():
    from lit_researcher.search import _merge_and_deduplicate

    papers = [
        {"doi": "", "title": "", "abstract": "orphan"},
    ]
    result = _merge_and_deduplicate(papers)
    assert len(result) == 1


def test_search_papers_with_stats_reports_counts():
    from lit_researcher import search as search_module

    def fake_db_a(_query: str, _limit: int) -> list[dict]:
        return [
            {"paper_id": "a1", "title": "Paper A", "doi": "10.1/a"},
            {"paper_id": "a2", "title": "Paper B", "doi": "10.1/b"},
        ]

    def fake_db_b(_query: str, _limit: int) -> list[dict]:
        return [
            {"paper_id": "b1", "title": "Paper A duplicate", "doi": "10.1/a"},
            {"paper_id": "b2", "title": "Paper C", "doi": "10.1/c"},
        ]

    with patch.dict(search_module._SEARCHER_REGISTRY, {"DBA": fake_db_a, "DBB": fake_db_b}, clear=True):
        results, stats = search_module.search_papers_with_stats(
            query="test",
            limit=5,
            databases=["DBA", "DBB"],
        )

    assert len(results) == 3
    assert stats["raw_count"] == 4
    assert stats["deduped_count"] == 3
    assert stats["returned_count"] == 3
    assert stats["db_counts"] == {"DBA": 2, "DBB": 2}


def test_search_papers_rolling_with_stats_filters_seen_candidates():
    from lit_researcher import search as search_module

    def fake_fetch(db_name, _query, _batch_size, cursor_state, round_number):
        if db_name == "OpenAlex" and round_number == 1:
            return (
                [
                    {"paper_id": "a1", "title": "Paper A", "doi": "10.1/a"},
                    {"paper_id": "a2", "title": "Paper B", "doi": "10.1/b"},
                ],
                {"cursor": "next"},
                False,
            )
        if db_name == "OpenAlex" and round_number == 2:
            return (
                [
                    {"paper_id": "a1-dup", "title": "Paper A duplicate", "doi": "10.1/a"},
                    {"paper_id": "a3", "title": "Paper C", "doi": "10.1/c"},
                ],
                {"cursor": None, "exhausted": True},
                True,
            )
        return ([], {**cursor_state, "exhausted": True}, True)

    with patch.object(search_module, "_fetch_rolling_db_batch", side_effect=fake_fetch):
        round1, stats1, state1, exhausted1 = search_module.search_papers_rolling_with_stats(
            "test",
            max_unique_candidates=5,
            databases=["OpenAlex"],
            round_number=1,
            seen_doi_keys=set(),
            seen_title_keys=set(),
            per_db_cursor_state={},
            current_unique_count=0,
            desired_new_candidates=2,
        )
        seen_dois = {"10.1/a", "10.1/b"}
        round2, stats2, _state2, exhausted2 = search_module.search_papers_rolling_with_stats(
            "test",
            max_unique_candidates=5,
            databases=["OpenAlex"],
            round_number=2,
            seen_doi_keys=seen_dois,
            seen_title_keys=set(),
            per_db_cursor_state=state1,
            current_unique_count=2,
            desired_new_candidates=2,
        )

    assert len(round1) == 2
    assert stats1["round_number"] == 1
    assert stats1["raw_count"] == 2
    assert len(round2) == 1
    assert round2[0]["doi"] == "10.1/c"
    assert exhausted1 == []
    assert exhausted2 == ["OpenAlex"]


# ── fetch.py tests ───────────────────────────────────────────────────────────


def test_is_valid_pdf():
    from lit_researcher.fetch import _is_valid_pdf

    assert _is_valid_pdf(b"%PDF-1.4 rest of content")
    assert not _is_valid_pdf(b"<html>not a pdf</html>")
    assert not _is_valid_pdf(b"")


def test_extract_pmc_xml_text():
    from lit_researcher.fetch import _extract_pmc_xml_text

    xml = """<article><body><p>Hello world</p><table><tr><td>skip</td></tr></table></body></article>"""
    text = _extract_pmc_xml_text(xml)
    assert "Hello world" in text
    assert "skip" not in text


def test_sanitize_html_text_removes_control_chars():
    from lit_researcher.fetch import _sanitize_html_text

    raw = "abc\x00def\x01ghi\nok"
    assert _sanitize_html_text(raw) == "abcdefghi\nok"


def test_extract_webpage_text_fallback_on_malformed_html():
    from lit_researcher import fetch

    class BrokenDocument:
        def __init__(self, _html: str):
            pass

        def summary(self):
            raise ValueError("bad html")

    html = "<html><body><h1>Title</h1><p>Hello\x00 world</p></body></html>"
    with patch("readability.Document", BrokenDocument):
        text = fetch._extract_webpage_text(html)

    assert "Title" in text
    assert "Hello world" in text


def test_should_retry_download_exception():
    from lit_researcher.fetch import _ForbiddenError, _should_retry_download_exception

    forbidden = _ForbiddenError(
        request_info=None,
        history=(),
        status=403,
        message="Forbidden",
        headers=None,
    )
    not_found = aiohttp.ClientResponseError(
        request_info=None,
        history=(),
        status=404,
        message="Not Found",
        headers=None,
    )

    assert _should_retry_download_exception(forbidden) is True
    assert _should_retry_download_exception(asyncio.TimeoutError()) is True
    assert _should_retry_download_exception(aiohttp.ClientConnectionError()) is True
    assert _should_retry_download_exception(not_found) is False


# ── extract.py tests ─────────────────────────────────────────────────────────


def test_chunk_text_single():
    from lit_researcher.extract import _chunk_text

    text = "short text"
    assert _chunk_text(text) == [text]


def test_chunk_text_multiple():
    from lit_researcher.extract import _chunk_text, CHUNK_SIZE

    text = "x" * (CHUNK_SIZE + 1000)
    chunks = _chunk_text(text)
    assert len(chunks) >= 2
    for chunk in chunks:
        assert len(chunk) <= CHUNK_SIZE


def test_parse_json_plain():
    from lit_researcher.extract import _parse_json

    assert _parse_json('{"a": 1}') == {"a": 1}
    assert _parse_json("") is None
    assert _parse_json("not json") is None


def test_parse_json_markdown_fenced():
    from lit_researcher.extract import _parse_json

    raw = '```json\n{"a": 1}\n```'
    assert _parse_json(raw) == {"a": 1}


def test_compute_data_quality():
    from lit_researcher.extract import _compute_data_quality
    from lit_researcher.config import FIELDS

    full = {f: "value" for f in FIELDS}
    assert _compute_data_quality(full) == 1.0

    empty = {f: None for f in FIELDS}
    assert _compute_data_quality(empty) == 0.0


def test_merge_chunk_results():
    from lit_researcher.extract import _merge_chunk_results

    results = [
        {"drug_name": "aspirin", "gelma_concentration": None, "_confidence": {"drug_name": "paper"}},
        {"drug_name": None, "gelma_concentration": "5", "_confidence": {"gelma_concentration": "paper"}},
    ]
    merged = _merge_chunk_results(results)
    assert merged["drug_name"] == "aspirin"
    assert merged["gelma_concentration"] == "5"


# ── checkpoint.py tests ──────────────────────────────────────────────────────


def test_checkpoint_round_trip():
    from lit_researcher.checkpoint import append_result, load_completed_ids, load_all_results

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)

    try:
        append_result({"paper_id": "p1", "drug_name": "test"}, path=path)
        append_result({"paper_id": "p2", "drug_name": "test2"}, path=path)

        ids = load_completed_ids(path=path)
        assert "p1" in ids
        assert "p2" in ids

        results = load_all_results(path=path)
        assert len(results) == 2
    finally:
        path.unlink(missing_ok=True)


# ── output.py tests ──────────────────────────────────────────────────────────


def test_write_csv():
    from lit_researcher.output import write_csv

    rows = [{"gelma_concentration": "5", "drug_name": "aspirin", "source_title": "Test", "source_doi": "10.1/x"}]
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
        path = Path(f.name)
    try:
        result_path = write_csv(rows, path=path)
        content = result_path.read_text(encoding="utf-8-sig")
        assert "gelma_concentration" in content
        assert "aspirin" in content
    finally:
        path.unlink(missing_ok=True)


# ── ui_helpers tests ─────────────────────────────────────────────────────────


def test_parse_doi_list():
    from lit_researcher.ui_helpers import parse_doi_list

    text = """
    10.1234/test.001
    https://doi.org/10.5678/test.002
    10.9999/test.003, 10.1111/test.004
    not-a-doi
    """
    dois = parse_doi_list(text)
    assert "10.1234/test.001" in dois
    assert "10.5678/test.002" in dois
    assert "10.9999/test.003" in dois
    assert "10.1111/test.004" in dois
    assert "not-a-doi" not in dois


def test_dois_to_papers():
    from lit_researcher.ui_helpers import dois_to_papers

    papers = dois_to_papers(["10.1/a", "10.2/b"])
    assert len(papers) == 2
    assert papers[0]["doi"] == "10.1/a"
    assert papers[0]["web_url"] == "https://doi.org/10.1/a"


# -- checkpoint: filter_unprocessed --


def test_filter_unprocessed():
    from lit_researcher.checkpoint import append_result, filter_unprocessed

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as f:
        path = Path(f.name)

    try:
        append_result({"paper_id": "p1", "drug_name": "done"}, path=path)

        papers = [
            {"paper_id": "p1", "title": "Already done"},
            {"paper_id": "p2", "title": "New paper"},
            {"paper_id": "p3", "title": "Another new"},
        ]
        result = filter_unprocessed(papers, path=path)
        assert len(result) == 2
        assert all(p["paper_id"] != "p1" for p in result)
    finally:
        path.unlink(missing_ok=True)


def test_save_task_persists_search_metadata(monkeypatch):
    from lit_researcher import ui_helpers

    history_dir = Path("tests-runtime-history")
    history_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(ui_helpers, "_HISTORY_DIR", history_dir)

    try:
        path = ui_helpers.save_task(
            "query",
            [{"source_title": "A"}],
            databases=["OpenAlex"],
            search_metadata={
                "raw_hit_count": 120,
                "deduped_count": 80,
                "returned_count": 80,
                "db_counts": {"OpenAlex": 120},
            },
        )

        task = json.loads(path.read_text(encoding="utf-8"))
        assert task["search_metadata"]["raw_hit_count"] == 120
        assert task["search_metadata"]["deduped_count"] == 80
        assert task["search_metadata"]["db_counts"] == {"OpenAlex": 120}
    finally:
        for file in history_dir.glob("task_*.json"):
            file.unlink(missing_ok=True)
        history_dir.rmdir()


def test_history_stats_aggregates_search_metadata():
    from lit_researcher.ui_helpers import history_stats

    history = [
        {
            "query": "q1",
            "count": 10,
            "rows": [{"text_source": "pdf", "_data_quality": 0.8}],
            "search_metadata": {
                "raw_hit_count": 100,
                "deduped_count": 40,
                "final_passed_count": 30,
            },
        },
        {
            "query": "q2",
            "count": 5,
            "rows": [{"text_source": "webpage", "_data_quality": 0.5}],
            "search_metadata": {
                "raw_hit_count": 50,
                "deduped_count": 20,
                "final_passed_count": 12,
            },
        },
        {
            "query": "pdf import",
            "count": 2,
            "rows": [{"text_source": "pdf", "_data_quality": 1.0}],
        },
    ]

    stats = history_stats(history)

    assert stats["total_raw_hits"] == 150
    assert stats["total_deduped_hits"] == 60
    assert stats["total_final_rows"] == 15
    assert stats["total_final_passed_count"] == 42
    assert round(stats["avg_effective_ratio"], 2) == 25.0


def test_cleanup_history_preview_respects_pushed_filter():
    from lit_researcher.ui_helpers import cleanup_history_preview

    history = [
        {
            "rows": [
                {
                    "source_doi": "10.1/a",
                    "_data_quality": 0.2,
                    "drug_name": "DOX",
                    "gelma_concentration": "5",
                    "_pushed_to_notion": True,
                },
                {
                    "source_doi": "10.1/b",
                    "_data_quality": 0.2,
                    "drug_name": "",
                    "gelma_concentration": "5",
                },
            ]
        }
    ]

    result = cleanup_history_preview(history, pushed_filter="unpushed")

    assert result["scope_count"] == 1
    assert result["removed"] == 1
    assert result["rows_after"] == 0
    assert result["breakdown"]["missing_drug_name"] == 1


def test_cleanup_history_scoped_only_removes_current_filter(monkeypatch):
    from lit_researcher import ui_helpers

    history_dir = Path("tests-runtime-history-cleanup")
    history_dir.mkdir(exist_ok=True)
    monkeypatch.setattr(ui_helpers, "_HISTORY_DIR", history_dir)

    try:
        task = {
            "query": "demo",
            "timestamp": "demo-ts",
            "count": 2,
            "rows": [
                {
                    "source_doi": "10.1/a",
                    "_data_quality": 0.2,
                    "drug_name": "DOX",
                    "gelma_concentration": "5",
                    "_pushed_to_notion": "2026-01-01T00:00:00",
                },
                {
                    "source_doi": "10.1/b",
                    "_data_quality": 0.2,
                    "drug_name": "",
                    "gelma_concentration": "5",
                },
            ],
        }
        (history_dir / "task_demo-ts.json").write_text(json.dumps(task, ensure_ascii=False), encoding="utf-8")

        result = ui_helpers.cleanup_history_scoped(pushed_filter="unpushed")

        assert result["removed"] == 1
        saved = json.loads((history_dir / "task_demo-ts.json").read_text(encoding="utf-8"))
        assert len(saved["rows"]) == 1
        assert saved["rows"][0]["source_doi"] == "10.1/a"
    finally:
        for file in history_dir.glob("task_*.json"):
            file.unlink(missing_ok=True)
        history_dir.rmdir()


# -- output: JSON and BibTeX --


def test_write_json():
    from lit_researcher.output import write_json

    rows = [{"drug_name": "aspirin", "source_doi": "10.1/x"}]
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = Path(f.name)
    try:
        result_path = write_json(rows, path=path)
        data = json.loads(result_path.read_text(encoding="utf-8"))
        assert len(data) == 1
        assert data[0]["drug_name"] == "aspirin"
    finally:
        path.unlink(missing_ok=True)


def test_write_bibtex():
    from lit_researcher.output import write_bibtex

    rows = [{"source_title": "Test Paper", "source_doi": "10.1/x", "drug_name": "aspirin"}]
    with tempfile.NamedTemporaryFile(suffix=".bib", delete=False) as f:
        path = Path(f.name)
    try:
        result_path = write_bibtex(rows, path=path)
        content = result_path.read_text(encoding="utf-8")
        assert "@article{" in content
        assert "Test Paper" in content
        assert "10.1/x" in content
    finally:
        path.unlink(missing_ok=True)


def test_filter_rows_by_quality():
    from lit_researcher.output import filter_rows_by_quality

    rows = [
        {"_review": "ok", "drug_name": "a"},
        {"_review": "low_quality", "drug_name": "b"},
        {"_review": "suspicious", "drug_name": "c"},
    ]
    assert len(filter_rows_by_quality(rows, min_review="ok")) == 1
    assert len(filter_rows_by_quality(rows, min_review="low_quality")) == 2
    assert len(filter_rows_by_quality(rows, min_review="all")) == 3
