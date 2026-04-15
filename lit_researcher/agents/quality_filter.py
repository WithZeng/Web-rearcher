"""QualityFilterAgent — multi-dimensional quality scoring and filtering."""

from __future__ import annotations

import re

from .base import BaseAgent, PipelineContext

_HIGH_QUALITY_SOURCES = {"pdf", "unpaywall", "pmc"}
_MEDIUM_QUALITY_SOURCES = {"webpage", "crossref_abstract", "s2_abstract", "search_abstract"}

_RELEVANCE_KEYWORDS = [
    "gelma", "gel-ma", "gelatin methacryloyl", "gelatin methacrylate",
    "microsphere", "microparticle", "microgel", "microcarrier", "microbead",
    "drug release", "drug delivery", "controlled release", "sustained release",
    "encapsulation", "drug loading",
]

_QUANTITATIVE_PATTERNS = [
    re.compile(r"\d+\.?\d*\s*%"),
    re.compile(r"\d+\.?\d*\s*(?:mg|μg|ng|mL|μL|kDa|Da|nm|μm|mm)"),
    re.compile(r"±\s*\d+"),
    re.compile(r"\d+\.?\d*\s*(?:hours?|h|days?|d|min)"),
]

_REVIEW_KEYWORDS = ["review", "meta-analysis", "systematic review", "survey", "overview"]


def score_relevance(text: str, title: str) -> float:
    """0-1 score: how relevant the paper is to GelMA/microsphere/drug release."""
    combined = (title + " " + text[:5000]).lower()
    hits = sum(1 for kw in _RELEVANCE_KEYWORDS if kw in combined)
    return min(hits / 5.0, 1.0)


def score_fulltext(text: str, text_source: str) -> float:
    """0-1 score: text availability and source quality."""
    if not text:
        return 0.0
    length = len(text)
    if text_source in _HIGH_QUALITY_SOURCES and length > 3000:
        return 1.0
    if text_source in _HIGH_QUALITY_SOURCES:
        return 0.7
    if text_source in _MEDIUM_QUALITY_SOURCES and length > 1000:
        return 0.5
    if text_source in _MEDIUM_QUALITY_SOURCES:
        return 0.3
    if length > 500:
        return 0.2
    return 0.1


def score_data_richness(text: str) -> float:
    """0-1 score: presence of quantitative data and experimental values."""
    if not text:
        return 0.0
    sample = text[:10000]
    hits = sum(1 for pat in _QUANTITATIVE_PATTERNS if pat.search(sample))
    table_like = sample.count("|") > 5 or "table" in sample.lower()
    score = hits / len(_QUANTITATIVE_PATTERNS)
    if table_like:
        score = min(score + 0.2, 1.0)
    return round(score, 2)


def score_article_type(text: str, title: str) -> float:
    """0-1 score: higher for original research, lower for pure reviews."""
    combined = (title + " " + text[:3000]).lower()
    review_hits = sum(1 for kw in _REVIEW_KEYWORDS if kw in combined)
    if review_hits >= 2:
        return 0.2
    if review_hits == 1:
        return 0.5
    has_methods = any(w in combined for w in ["materials and methods", "experimental", "methodology"])
    has_results = any(w in combined for w in ["results", "findings", "characterization"])
    if has_methods and has_results:
        return 1.0
    if has_methods or has_results:
        return 0.8
    return 0.6


def compute_quality_scores(paper: dict) -> dict:
    """Compute all quality dimensions for a single paper.

    Returns a dict with relevance_score, fulltext_score, data_richness_score,
    article_type_score, total_score, and quality_label.
    """
    text = paper.get("text", "")
    title = paper.get("title", "")
    text_source = paper.get("text_source", "none")

    rel = score_relevance(text, title)
    ft = score_fulltext(text, text_source)
    dr = score_data_richness(text)
    at = score_article_type(text, title)

    total = round(0.3 * rel + 0.25 * ft + 0.25 * dr + 0.2 * at, 3)

    if total >= 0.6:
        label = "high_value"
    elif total >= 0.3:
        label = "medium_value"
    else:
        label = "low_value"

    return {
        "relevance_score": round(rel, 3),
        "fulltext_score": round(ft, 3),
        "data_richness_score": round(dr, 3),
        "article_type_score": round(at, 3),
        "total_score": total,
        "quality_label": label,
    }


class QualityFilterAgent(BaseAgent):
    name = "QualityFilterAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        passed: list[dict] = []
        failed: list[dict] = []
        total = len(ctx.papers_with_text)

        for idx, paper in enumerate(ctx.papers_with_text):
            if idx % 5 == 0:
                ctx.emit_activity(f"评估质量 [{idx + 1}/{total}] {paper.get('title', '?')[:40]}...")
            scores = compute_quality_scores(paper)
            paper["_quality_scores"] = scores

            if scores["relevance_score"] < 0.2:
                failed.append(paper)
            elif scores["total_score"] < 0.25:
                failed.append(paper)
            elif scores["article_type_score"] <= 0.2 and scores["data_richness_score"] < 0.3:
                failed.append(paper)
            else:
                passed.append(paper)

        ctx.passed_papers = passed
        ctx.failed_papers = failed

        high = sum(1 for p in passed if p.get("_quality_scores", {}).get("quality_label") == "high_value")
        medium = sum(1 for p in passed if p.get("_quality_scores", {}).get("quality_label") == "medium_value")
        low = sum(1 for p in passed if p.get("_quality_scores", {}).get("quality_label") == "low_value")

        self._log(
            ctx,
            f"passed={len(passed)} (high={high}, medium={medium}, low={low}), "
            f"failed={len(failed)}",
        )
        return ctx
