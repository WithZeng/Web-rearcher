"""Orchestrator -- drives the multi-agent pipeline.

Supports two modes:
  - "single": planner -> search -> retrieval -> quality_filter -> extraction (unified) -> reviewer
  - "multi":  planner -> search -> retrieval -> quality_filter -> 4 sub-agents -> merge -> reviewer

Both modes preserve the original single-flow as a fallback.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Any

from .. import config
from ..checkpoint import filter_unprocessed
from ..extract import _compute_data_quality
from .base import PipelineContext
from .drug_agent import DrugAgent
from .extraction_agent import ExtractionAgent
from .gelma_agent import GelmaAgent
from .planner import PlannerAgent
from .quality_filter import QualityFilterAgent
from .release_agent import ReleaseAgent
from .retrieval_agent import RetrievalAgent
from .reviewer import ReviewerAgent
from .search_agent import SearchAgent
from .source_agent import SourceAgent

logger = logging.getLogger(__name__)

_DOMAIN_PREFILTER_TERMS = (
    "gelma", "gel-ma", "gelatin methacryloyl", "gelatin methacrylate",
    "microsphere", "microparticle", "microgel",
    "controlled release", "sustained release", "drug release",
)


def _should_apply_domain_prefilter(query: str) -> bool:
    lowered = (query or "").lower()
    hits = sum(1 for term in _DOMAIN_PREFILTER_TERMS if term in lowered)
    return hits >= 2


def _prefilter_retrieval_candidates(query: str, papers: list[dict]) -> tuple[list[dict], int]:
    if not _should_apply_domain_prefilter(query):
        return papers, 0

    from .quality_filter import score_relevance

    kept: list[dict] = []
    filtered = 0
    for paper in papers:
        title = str(paper.get("title") or "")
        abstract = str(paper.get("abstract") or "")
        if score_relevance(abstract, title) >= 0.2:
            kept.append(paper)
        else:
            filtered += 1
    return kept, filtered


def _pick_best_value(a, b):
    """Pick the better of two values: prefer non-None, then longer string."""
    if a is None:
        return b
    if b is None:
        return a
    if isinstance(a, str) and isinstance(b, str):
        return a if len(a) >= len(b) else b
    return a


def _merge_sub_results(ctx: PipelineContext) -> None:
    """Merge results from 4 sub-extraction agents into ctx.rows."""
    n = len(ctx.passed_papers)
    rows: list[dict] = []

    for i in range(n):
        merged: dict = {}
        merged_conf: dict = {}

        for sub in [ctx._gelma_results, ctx._drug_results, ctx._release_results, ctx._source_results]:
            if i < len(sub):
                for key, value in sub[i].items():
                    if key == "_confidence" and isinstance(value, dict):
                        for conf_key, conf_value in value.items():
                            if conf_value is not None and (merged_conf.get(conf_key) is None or conf_value == "paper"):
                                merged_conf[conf_key] = conf_value
                        continue
                    merged[key] = _pick_best_value(merged.get(key), value)

        paper = ctx.passed_papers[i] if i < len(ctx.passed_papers) else {}
        if not merged.get("source_title"):
            merged["source_title"] = paper.get("title", "")
        if not merged.get("source_doi"):
            merged["source_doi"] = paper.get("doi", "")

        if merged_conf:
            merged["_confidence"] = merged_conf

        merged["_data_quality"] = _compute_data_quality(merged)
        merged["paper_id"] = paper.get("paper_id", "")
        if paper.get("text_source"):
            merged["text_source"] = paper["text_source"]

        quality_scores = paper.get("_quality_scores")
        if quality_scores:
            merged["_quality_label"] = quality_scores.get("quality_label", "")
            merged["_quality_total"] = quality_scores.get("total_score", 0)

        rows.append(merged)

    ctx.rows = rows


async def _enrich_with_pubchem(rows: list[dict], on_activity: Callable[[str], Any] | None = None) -> None:
    """Enrich rows with PubChem drug properties, batching by unique drug name."""
    from ..pubchem import batch_lookup, enrich_row

    drug_names: set[str] = set()
    for row in rows:
        name = str(row.get("drug_name") or "").strip()
        if name:
            drug_names.add(name)

    if not drug_names:
        return

    if on_activity:
        on_activity(f"Querying PubChem for {len(drug_names)} unique drugs...")

    cache, stats = await batch_lookup(drug_names)

    if on_activity and stats.get("cache_hit"):
        on_activity(f"PubChem cache hit {stats['cache_hit']} drugs, queried {stats['queried']} drugs")

    total_filled = 0
    for row in rows:
        name = str(row.get("drug_name") or "").strip()
        if name and name in cache and cache[name]:
            filled = enrich_row(row, cache[name])
            if filled:
                total_filled += filled
                row["_data_quality"] = _compute_data_quality(row)

    if total_filled:
        logger.info("PubChem enriched %d fields across %d drugs", total_filled, len([d for d in cache.values() if d]))
        if on_activity:
            on_activity(f"PubChem filled {total_filled} fields")


def _normalize_paper_signature(paper: dict) -> str:
    doi = str(paper.get("doi") or paper.get("source_doi") or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
    if doi:
        return f"doi:{doi.strip('/')}"

    title = str(paper.get("title") or paper.get("source_title") or "").strip().lower()[:120]
    if title:
        return f"title:{title}"

    return f"id:{paper.get('paper_id') or id(paper)}"


def _extend_unique_papers(target: list[dict], incoming: list[dict]) -> int:
    seen = {_normalize_paper_signature(paper) for paper in target}
    added = 0
    for paper in incoming:
        sig = _normalize_paper_signature(paper)
        if sig in seen:
            continue
        seen.add(sig)
        target.append(paper)
        added += 1
    return added


async def _run_sub_agents_parallel(ctx: PipelineContext) -> PipelineContext:
    """Run all 4 sub-extraction agents concurrently."""
    import asyncio

    gelma = GelmaAgent()
    drug = DrugAgent()
    release = ReleaseAgent()
    source = SourceAgent()

    results = await asyncio.gather(
        gelma.run_timed(ctx),
        drug.run_timed(ctx),
        release.run_timed(ctx),
        source.run_timed(ctx),
        return_exceptions=True,
    )

    for result in results:
        if isinstance(result, Exception):
            logger.warning("Sub-agent failed: %s", result)

    return ctx


async def run_pipeline(
    query: str,
    limit: int | None = None,
    target_passed_count: int | None = None,
    databases: list[str] | None = None,
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
    use_planner: bool = True,
    on_stage: Callable[[str, PipelineContext], Any] | None = None,
    on_activity: Callable[[str], Any] | None = None,
    max_retries: int = 1,
    mode: str = "multi",
    resume: bool = False,
    pause_after_filter: Callable[[PipelineContext], bool] | None = None,
    cancel_check: Callable[[], None] | None = None,
) -> list[dict]:
    """Run the full pipeline and return reviewed rows."""
    max_unique_candidates = limit or config.MAX_RESULTS
    ctx = PipelineContext(
        query=query,
        limit=max_unique_candidates,
        databases=databases or list(config.DEFAULT_DATABASES),
        fetch_concurrency=fetch_concurrency or config.FETCH_CONCURRENCY,
        llm_concurrency=llm_concurrency or config.LLM_CONCURRENCY,
        target_passed_count=target_passed_count,
        max_unique_candidates=max_unique_candidates,
        rolling_mode=bool(target_passed_count),
        mode=mode,
        _on_activity=on_activity,
        _cancel_check=cancel_check,
    )

    def _notify(stage: str) -> None:
        ctx.check_cancelled()
        if on_stage:
            on_stage(stage, ctx)

    if use_planner:
        ctx.emit_activity("Generating search strategy...")
        ctx = await PlannerAgent().run_timed(ctx)
        _notify("planner")

    db_names = ", ".join(ctx.databases)
    if ctx.rolling_mode:
        ctx.emit_activity(
            f"Rolling recall enabled: searching {db_names} until {ctx.target_passed_count} high-quality papers "
            f"or {ctx.max_unique_candidates} unique candidates"
        )

        while True:
            ctx.search_round += 1
            ctx.round_number = ctx.search_round
            remaining_target = max((ctx.target_passed_count or 0) - len(ctx.accumulated_passed_papers), 0)
            remaining_capacity = max((ctx.max_unique_candidates or ctx.limit) - len(ctx.candidate_pool), 0)
            if remaining_capacity <= 0:
                ctx.stop_reason = "max_unique_candidates"
                break

            ctx.desired_new_candidates = min(
                remaining_capacity,
                max(100, min(1000, remaining_target * 3 if remaining_target else 100)),
            )

            ctx.emit_activity(
                f"Round {ctx.search_round}: searching {db_names} for ~{ctx.desired_new_candidates} new candidates"
            )
            ctx = await SearchAgent().run_timed(ctx)
            _notify("search")

            round_stats = ctx._search_stats or {}
            if not ctx.papers:
                if set(ctx.sources_exhausted) >= set(ctx.databases):
                    ctx.stop_reason = "sources_exhausted"
                    break
                ctx.round_summaries.append({
                    "round": ctx.search_round,
                    "raw_count": int(round_stats.get("round_raw_count") or 0),
                    "deduped_count": 0,
                    "blacklist_skipped": 0,
                    "history_skipped": 0,
                    "passed_count": len(ctx.accumulated_passed_papers),
                    "failed_count": 0,
                })
                continue

            _extend_unique_papers(ctx.candidate_pool, ctx.papers)

            if resume:
                ctx.papers = filter_unprocessed(ctx.papers)
                if not ctx.papers:
                    if set(ctx.sources_exhausted) >= set(ctx.databases):
                        ctx.stop_reason = "sources_exhausted"
                        break
                    continue

            from ..blacklist import filter_blacklisted
            from ..ui_helpers import filter_history_duplicates

            before_blacklist = len(ctx.papers)
            ctx.papers = filter_blacklisted(ctx.papers)
            blacklist_skipped = before_blacklist - len(ctx.papers)
            ctx.blacklist_skipped += blacklist_skipped

            ctx.papers, hist_skipped = filter_history_duplicates(ctx.papers)
            ctx.history_skipped += hist_skipped

            ctx.papers, relevance_prefiltered = _prefilter_retrieval_candidates(query, ctx.papers)

            ctx.emit_activity(
                f"Round {ctx.search_round}: raw {round_stats.get('round_raw_count', 0)}, "
                f"new unique {round_stats.get('round_returned_count', 0)}, "
                f"blacklist skipped {blacklist_skipped}, history skipped {hist_skipped}, "
                f"prefilter skipped {relevance_prefiltered}, remaining {len(ctx.papers)}"
            )

            if ctx.papers:
                ctx.papers_with_text = []
                ctx.passed_papers = []
                ctx.failed_papers = []
                ctx.retry_count = 0

                ctx.retrieval_round += 1
                ctx.round_number = ctx.retrieval_round
                ctx.emit_activity(f"Round {ctx.search_round}: first-pass retrieval for {len(ctx.papers)} papers")
                ctx = await RetrievalAgent().run_timed(ctx)
                _notify("retrieval")

                ctx.quality_filter_round += 1
                ctx.round_number = ctx.quality_filter_round
                ctx = await QualityFilterAgent().run_timed(ctx)
                ctx.passed_count = len(ctx.accumulated_passed_papers) + len(ctx.passed_papers)
                _notify("quality_filter")

                for _attempt in range(max_retries):
                    if not ctx.failed_papers:
                        break
                    ctx.retry_count += 1
                    ctx.retry_retrieval_round += 1
                    ctx.round_number = ctx.retry_retrieval_round
                    ctx.emit_activity(
                        f"Round {ctx.search_round}: retry retrieval {ctx.retry_count} for {len(ctx.failed_papers)} failed papers"
                    )
                    logger.info(
                        "Round %d retry retrieval %d: re-fetching %d failed papers",
                        ctx.search_round,
                        ctx.retry_count,
                        len(ctx.failed_papers),
                    )
                    ctx = await RetrievalAgent().run_timed(ctx)
                    _notify("retrieval")
                    ctx.quality_filter_round += 1
                    ctx.round_number = ctx.quality_filter_round
                    ctx = await QualityFilterAgent().run_timed(ctx)
                    ctx.passed_count = len(ctx.accumulated_passed_papers) + len(ctx.passed_papers)
                    _notify("quality_filter")

                added_passed = _extend_unique_papers(ctx.accumulated_passed_papers, ctx.passed_papers)
                _extend_unique_papers(ctx.accumulated_failed_papers, ctx.failed_papers)
                ctx.passed_count = len(ctx.accumulated_passed_papers)
            else:
                added_passed = 0

            ctx.round_summaries.append({
                "round": ctx.search_round,
                "raw_count": int(round_stats.get("round_raw_count") or 0),
                "deduped_count": int(round_stats.get("round_returned_count") or 0),
                "blacklist_skipped": blacklist_skipped,
                "history_skipped": hist_skipped,
                "passed_count": len(ctx.accumulated_passed_papers),
                "added_passed": added_passed,
                "failed_count": len(ctx.failed_papers),
            })

            if ctx.target_passed_count and len(ctx.accumulated_passed_papers) >= ctx.target_passed_count:
                ctx.stop_reason = "target_passed_count_reached"
                break
            if len(ctx.candidate_pool) >= (ctx.max_unique_candidates or ctx.limit):
                ctx.stop_reason = "max_unique_candidates"
                break
            if set(ctx.sources_exhausted) >= set(ctx.databases):
                ctx.stop_reason = "sources_exhausted"
                break

        if not ctx.accumulated_passed_papers:
            logger.warning("No high-quality papers collected for query: %s", query)
            return []

        final_stats = dict(ctx._search_stats or {})
        final_stats.update({
            "raw_count": int(final_stats.get("raw_count") or 0),
            "deduped_count": len(ctx.candidate_pool),
            "returned_count": len(ctx.accumulated_passed_papers),
            "blacklist_skipped": ctx.blacklist_skipped,
            "history_skipped": ctx.history_skipped,
            "target_passed_count": ctx.target_passed_count,
            "final_passed_count": len(ctx.accumulated_passed_papers),
            "rounds_completed": ctx.search_round,
            "exhausted_sources": sorted(ctx.sources_exhausted),
            "stop_reason": ctx.stop_reason,
        })
        ctx._search_stats = final_stats
        ctx.passed_papers = list(ctx.accumulated_passed_papers)
        ctx.failed_papers = list(ctx.accumulated_failed_papers)
        ctx.emit_activity(
            f"Rolling recall finished: {len(ctx.accumulated_passed_papers)}/{ctx.target_passed_count} passed, "
            f"{len(ctx.candidate_pool)} unique candidates, stop={ctx.stop_reason}"
        )
    else:
        ctx.emit_activity(f"Searching {db_names}...")
        ctx = await SearchAgent().run_timed(ctx)
        _notify("search")
        if not ctx.papers:
            logger.warning("No papers found for query: %s", query)
            return []

        search_stats = ctx._search_stats or {}
        raw_count = int(search_stats.get("raw_count") or len(ctx.papers))
        deduped_count = int(search_stats.get("deduped_count") or len(ctx.papers))
        db_counts = search_stats.get("db_counts") or {}
        if db_counts:
            parts = [f"{db}:{count}" for db, count in db_counts.items()]
            ctx.emit_activity(f"Search complete: raw {raw_count}, deduped {deduped_count}, per-db {', '.join(parts)}")
        else:
            ctx.emit_activity(f"Search complete: raw {raw_count}, deduped {deduped_count}")

        if resume:
            ctx.papers = filter_unprocessed(ctx.papers)
            if not ctx.papers:
                logger.info("Resume: all papers already processed")
                return []

        from ..blacklist import filter_blacklisted
        from ..ui_helpers import filter_history_duplicates

        before_blacklist = len(ctx.papers)
        ctx.papers = filter_blacklisted(ctx.papers)
        blacklist_skipped = before_blacklist - len(ctx.papers)
        ctx.blacklist_skipped = blacklist_skipped
        ctx.emit_activity(f"Blacklist filtered {blacklist_skipped}, remaining {len(ctx.papers)}")
        if blacklist_skipped:
            logger.info("Blacklist removed %d papers", blacklist_skipped)

        ctx.papers, hist_skipped = filter_history_duplicates(ctx.papers)
        ctx.history_skipped = hist_skipped
        ctx.emit_activity(f"History dedup filtered {hist_skipped}, remaining {len(ctx.papers)}")
        if hist_skipped:
            logger.info("History dedup removed %d papers", hist_skipped)

        ctx.papers, relevance_prefiltered = _prefilter_retrieval_candidates(query, ctx.papers)
        if relevance_prefiltered:
            ctx.emit_activity(f"Domain prefilter skipped {relevance_prefiltered}, remaining {len(ctx.papers)}")
            logger.info("Domain prefilter removed %d low-relevance candidates", relevance_prefiltered)
        if not ctx.papers:
            logger.info("All papers already in history")
            return []

        ctx.emit_activity(
            f"Starting full-text retrieval for {len(ctx.papers)} papers "
            f"(raw {raw_count} / deduped {deduped_count} / blacklist {blacklist_skipped} / history {hist_skipped})"
        )
        ctx = await RetrievalAgent().run_timed(ctx)
        _notify("retrieval")

        ctx.emit_activity(f"Scoring quality for {len(ctx.papers_with_text)} papers...")
        ctx = await QualityFilterAgent().run_timed(ctx)
        _notify("quality_filter")
        ctx.emit_activity(
            f"Quality filter complete: passed {len(ctx.passed_papers)}, failed {len(ctx.failed_papers)}"
        )

        for _attempt in range(max_retries):
            if not ctx.failed_papers:
                break
            ctx.retry_count += 1
            ctx.emit_activity(
                f"Retry retrieval [{ctx.retry_count}]: refetching {len(ctx.failed_papers)} papers that failed quality screening"
            )
            logger.info("Retry %d: re-fetching %d failed papers", ctx.retry_count, len(ctx.failed_papers))
            ctx = await RetrievalAgent().run_timed(ctx)
            _notify("retrieval")
            ctx = await QualityFilterAgent().run_timed(ctx)
            _notify("quality_filter")

    if pause_after_filter:
        should_continue = pause_after_filter(ctx)
        if not should_continue:
            logger.info("Pipeline paused by user after quality filter")
            return []

    n = len(ctx.passed_papers)
    if mode == "multi":
        stage_name = "extraction_sub_agents"
        ctx.round_number = ctx.search_round if ctx.rolling_mode else 0
        ctx.emit_activity(f"Launching 4 sub-agents to extract {n} papers...")
        ctx = await _run_sub_agents_parallel(ctx)
        _notify(stage_name)
        ctx.emit_activity("Merging extraction results...")
        _merge_sub_results(ctx)
        _notify("extraction_merge")
    else:
        stage_name = "extraction"
        ctx.round_number = ctx.search_round if ctx.rolling_mode else 0
        ctx.emit_activity(f"Running unified extraction for {n} papers...")
        ctx = await ExtractionAgent().run_timed(ctx)
        _notify(stage_name)

    try:
        await _enrich_with_pubchem(ctx.rows, on_activity=on_activity)
    except Exception as exc:
        logger.warning("PubChem enrichment failed: %s", exc)

    ctx.round_number = ctx.search_round if ctx.rolling_mode else 0
    ctx.emit_activity(f"Reviewing {len(ctx.rows)} extracted rows...")
    ctx = await ReviewerAgent().run_timed(ctx)
    _notify("reviewer")

    if ctx._retry_queue and ctx.retry_count < max_retries + 1:
        ctx.emit_activity(f"Reviewer flagged {len(ctx._retry_queue)} suspicious rows, retrying extraction...")
        logger.info("Reviewer retry: re-extracting %d suspicious papers", len(ctx._retry_queue))
        retry_ctx = PipelineContext(
            query=ctx.query,
            limit=len(ctx._retry_queue),
            databases=ctx.databases,
            fetch_concurrency=ctx.fetch_concurrency,
            llm_concurrency=ctx.llm_concurrency,
            mode=ctx.mode,
        )
        retry_ctx.passed_papers = ctx._retry_queue

        if mode == "multi":
            retry_ctx = await _run_sub_agents_parallel(retry_ctx)
            _merge_sub_results(retry_ctx)
        else:
            retry_ctx = await ExtractionAgent().run_timed(retry_ctx)

        retry_ctx = await ReviewerAgent().run_timed(retry_ctx)

        retry_dois = {row.get("source_doi") for row in retry_ctx.reviewed_rows if row.get("source_doi")}
        kept = [row for row in ctx.reviewed_rows if row.get("source_doi") not in retry_dois]
        ctx.reviewed_rows = kept + retry_ctx.reviewed_rows
        _notify("reviewer_retry")

    logger.info(
        "Pipeline complete (%s mode): %d reviewed rows, %d logs",
        mode,
        len(ctx.reviewed_rows),
        len(ctx.logs),
    )
    return ctx.reviewed_rows
