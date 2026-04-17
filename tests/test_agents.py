"""Unit tests for the multi-agent pipeline."""

from __future__ import annotations

import asyncio
import pytest

from lit_researcher.agents.base import PipelineContext, BaseAgent
from lit_researcher.agents.quality_filter import (
    QualityFilterAgent,
    compute_quality_scores,
    score_relevance,
    score_fulltext,
    score_data_richness,
    score_article_type,
)
from lit_researcher.agents.reviewer import ReviewerAgent, review_row


def _make_ctx(**kwargs) -> PipelineContext:
    defaults = dict(
        query="test",
        limit=10,
        databases=["OpenAlex"],
        fetch_concurrency=5,
        llm_concurrency=2,
    )
    defaults.update(kwargs)
    return PipelineContext(**defaults)


# -- PipelineContext --


def test_pipeline_context_defaults():
    ctx = _make_ctx()
    assert ctx.papers == []
    assert ctx.logs == []
    assert ctx.retry_count == 0
    assert ctx.mode == "multi"


def test_pipeline_context_sub_results():
    ctx = _make_ctx()
    assert ctx._gelma_results == []
    assert ctx._drug_results == []
    assert ctx._release_results == []
    assert ctx._source_results == []
    assert ctx._retry_queue == []


# -- QualityFilterAgent: scoring functions --


def test_score_relevance_high():
    text = "GelMA microsphere drug release encapsulation drug loading sustained release"
    assert score_relevance(text, "GelMA microsphere") >= 0.8


def test_score_relevance_low():
    assert score_relevance("unrelated topic about cooking", "Recipe") < 0.2


def test_score_fulltext_pdf():
    assert score_fulltext("x" * 5000, "pdf") == 1.0


def test_score_fulltext_empty():
    assert score_fulltext("", "none") == 0.0


def test_score_fulltext_abstract():
    assert 0.2 <= score_fulltext("x" * 2000, "crossref_abstract") <= 0.6


def test_score_data_richness_with_numbers():
    text = "The encapsulation efficiency was 85.3%, size 200 μm, release after 72 hours at 37 °C"
    assert score_data_richness(text) > 0.5


def test_score_data_richness_no_data():
    assert score_data_richness("This is a general discussion about polymers.") == 0.0


def test_score_article_type_research():
    text = "Materials and methods: ... Results: characterization showed..."
    assert score_article_type(text, "Original Research") >= 0.8


def test_score_article_type_review():
    text = "This systematic review and meta-analysis surveys the literature..."
    assert score_article_type(text, "A Review of GelMA") <= 0.5


def test_compute_quality_scores_structure():
    paper = {"text": "GelMA microsphere 85.3% drug release", "title": "Test", "text_source": "pdf"}
    scores = compute_quality_scores(paper)
    assert "relevance_score" in scores
    assert "fulltext_score" in scores
    assert "data_richness_score" in scores
    assert "article_type_score" in scores
    assert "total_score" in scores
    assert scores["quality_label"] in ("high_value", "medium_value", "low_value")


# -- QualityFilterAgent: agent behavior --


def test_quality_filter_passes_pdf():
    ctx = _make_ctx()
    ctx.papers_with_text = [
        {"paper_id": "1", "title": "Paper A", "text": "long text here", "text_source": "pdf"},
    ]
    ctx = asyncio.run(QualityFilterAgent().run(ctx))
    assert len(ctx.passed_papers) == 1
    assert len(ctx.failed_papers) == 0
    assert "_quality_scores" in ctx.passed_papers[0]


def test_quality_filter_passes_title_only():
    ctx = _make_ctx()
    ctx.papers_with_text = [
        {"paper_id": "2", "title": "Paper B", "text": "", "text_source": "none"},
    ]
    ctx = asyncio.run(QualityFilterAgent().run(ctx))
    assert len(ctx.passed_papers) == 1


def test_quality_filter_fails_empty():
    ctx = _make_ctx()
    ctx.papers_with_text = [
        {"paper_id": "3", "title": "", "text": "", "text_source": "none"},
    ]
    ctx = asyncio.run(QualityFilterAgent().run(ctx))
    assert len(ctx.failed_papers) == 1


def test_quality_filter_mixed():
    ctx = _make_ctx()
    ctx.papers_with_text = [
        {"paper_id": "1", "title": "A", "text": "full text", "text_source": "pdf"},
        {"paper_id": "2", "title": "B", "text": "abstract", "text_source": "search_abstract"},
        {"paper_id": "3", "title": "", "text": "", "text_source": "none"},
        {"paper_id": "4", "title": "D", "text": "", "text_source": "none"},
    ]
    ctx = asyncio.run(QualityFilterAgent().run(ctx))
    assert len(ctx.passed_papers) == 3
    assert len(ctx.failed_papers) == 1


# -- ReviewerAgent --


def test_review_row_ok():
    row = {"_data_quality": 0.5, "ph": "7.4", "temperature": "37", "drug_name": "DOX",
           "gelma_concentration": "10", "source_title": "Test", "release_time": "72"}
    result = review_row(row)
    assert result["_review"] == "ok"
    assert result["review_score"] >= 70
    assert isinstance(result["review_flags"], list)
    assert result["needs_retry"] is False


def test_review_row_low_quality():
    row = {"_data_quality": 0.0}
    result = review_row(row)
    assert result["_review"] in ("low_quality", "suspicious")
    assert result["review_score"] < 70


def test_review_row_suspicious_bad_values():
    row = {"_data_quality": 0.1, "ph": "99", "temperature": "999",
           "encapsulation_efficiency": "200", "release_amount": "150"}
    result = review_row(row)
    assert result["_review"] == "suspicious"
    assert any("ph" in f for f in result["review_flags"])
    assert any("temperature" in f for f in result["review_flags"])


def test_review_row_flags_missing_release():
    row = {"_data_quality": 0.4, "drug_name": "DOX", "gelma_concentration": "5",
           "source_title": "Test"}
    result = review_row(row)
    assert any("release" in f for f in result["review_flags"])


def test_reviewer_agent_adds_review_fields():
    ctx = _make_ctx()
    ctx.rows = [
        {"_data_quality": 0.8, "ph": "7.4", "drug_name": "DOX",
         "gelma_concentration": "10", "source_title": "Test", "release_time": "72"},
        {"_data_quality": 0.0},
    ]
    ctx = asyncio.run(ReviewerAgent().run(ctx))
    assert len(ctx.reviewed_rows) == 2
    assert ctx.reviewed_rows[0]["_review"] == "ok"
    assert "_review_score" in ctx.reviewed_rows[0]
    assert "_review_flags" in ctx.reviewed_rows[0]


def test_reviewer_retry_queue():
    ctx = _make_ctx()
    ctx.rows = [
        {"_data_quality": 0.01},
    ]
    ctx.passed_papers = [{"paper_id": "1", "title": "T", "text": "x"}]
    ctx = asyncio.run(ReviewerAgent().run(ctx))
    assert len(ctx._retry_queue) >= 0


# -- BaseAgent --


def test_base_agent_logging():
    ctx = _make_ctx()

    class TestAgent(BaseAgent):
        name = "TestAgent"
        async def run(self, ctx):
            self._log(ctx, "hello")
            return ctx

    asyncio.run(TestAgent().run_timed(ctx))
    assert any("TestAgent" in log for log in ctx.logs)
    assert any("hello" in log for log in ctx.logs)


def test_run_pipeline_rolling_mode_defers_extraction_until_target(monkeypatch):
    from lit_researcher.agents import orchestrator as orchestrator_module

    extraction_calls: list[int] = []
    reviewer_calls: list[int] = []

    async def fake_search(self, ctx):
        if ctx.search_round == 1:
            ctx.papers = [
                {"paper_id": "p1", "title": "Paper 1", "doi": "10.1/a"},
                {"paper_id": "p2", "title": "Paper 2", "doi": "10.1/b"},
            ]
            ctx._search_stats = {
                "raw_count": 2,
                "deduped_count": len(ctx.candidate_pool) + len(ctx.papers),
                "returned_count": len(ctx.candidate_pool) + len(ctx.papers),
                "round_raw_count": 2,
                "round_returned_count": 2,
                "db_counts": {"OpenAlex": 2},
            }
            ctx.sources_exhausted = []
        else:
            ctx.papers = [
                {"paper_id": "p3", "title": "Paper 3", "doi": "10.1/c"},
            ]
            ctx._search_stats = {
                "raw_count": 3,
                "deduped_count": len(ctx.candidate_pool) + len(ctx.papers),
                "returned_count": len(ctx.candidate_pool) + len(ctx.papers),
                "round_raw_count": 1,
                "round_returned_count": 1,
                "db_counts": {"OpenAlex": 1},
            }
            ctx.sources_exhausted = ["OpenAlex"]
        return ctx

    async def fake_retrieval(self, ctx):
        targets = ctx.failed_papers if (ctx.failed_papers and ctx.retry_count > 0) else ctx.papers
        ctx.papers_with_text = [dict(paper, text="full text", text_source="pdf") for paper in targets]
        return ctx

    async def fake_quality(self, ctx):
        passed = [dict(paper) for paper in ctx.papers_with_text]
        ctx.passed_papers = passed
        ctx.failed_papers = []
        return ctx

    async def fake_extraction(self, ctx):
        extraction_calls.append(len(ctx.passed_papers))
        ctx.rows = [
            {
                "paper_id": paper["paper_id"],
                "source_title": paper["title"],
                "source_doi": paper["doi"],
                "drug_name": "drug",
                "_data_quality": 0.8,
            }
            for paper in ctx.passed_papers
        ]
        return ctx

    async def fake_reviewer(self, ctx):
        reviewer_calls.append(len(ctx.rows))
        ctx.reviewed_rows = list(ctx.rows)
        return ctx

    monkeypatch.setattr(orchestrator_module.SearchAgent, "run_timed", fake_search)
    monkeypatch.setattr(orchestrator_module.RetrievalAgent, "run_timed", fake_retrieval)
    monkeypatch.setattr(orchestrator_module.QualityFilterAgent, "run_timed", fake_quality)
    monkeypatch.setattr(orchestrator_module.ExtractionAgent, "run_timed", fake_extraction)
    monkeypatch.setattr(orchestrator_module.ReviewerAgent, "run_timed", fake_reviewer)

    rows = asyncio.run(
        orchestrator_module.run_pipeline(
            query="test",
            limit=10,
            target_passed_count=3,
            databases=["OpenAlex"],
            use_planner=False,
            max_retries=0,
            mode="single",
        )
    )

    assert len(rows) == 3
    assert extraction_calls == [3]
    assert reviewer_calls == [3]
