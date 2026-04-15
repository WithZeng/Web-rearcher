"""Unit tests for core pipeline functions."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch, AsyncMock

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
