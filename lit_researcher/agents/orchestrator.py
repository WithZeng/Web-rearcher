"""Orchestrator -- drives the multi-agent pipeline.

Supports two modes:
  - "single": planner -> search -> retrieval -> quality_filter -> extraction (unified) -> reviewer
  - "multi":  planner -> search -> retrieval -> quality_filter -> 4 sub-agents -> merge -> reviewer

Both modes preserve the original single-flow as a fallback.
"""

from __future__ import annotations

import logging
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
    ctx = PipelineContext(
        query=query,
        limit=limit or config.MAX_RESULTS,
        databases=databases or list(config.DEFAULT_DATABASES),
        fetch_concurrency=fetch_concurrency or config.FETCH_CONCURRENCY,
        llm_concurrency=llm_concurrency or config.LLM_CONCURRENCY,
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

    before_blacklist = len(ctx.papers)
    ctx.papers = filter_blacklisted(ctx.papers)
    blacklist_skipped = before_blacklist - len(ctx.papers)
    ctx.emit_activity(f"Blacklist filtered {blacklist_skipped}, remaining {len(ctx.papers)}")
    if blacklist_skipped:
        logger.info("Blacklist removed %d papers", blacklist_skipped)

    from ..ui_helpers import filter_history_duplicates

    ctx.papers, hist_skipped = filter_history_duplicates(ctx.papers)
    ctx.emit_activity(f"History dedup filtered {hist_skipped}, remaining {len(ctx.papers)}")
    if hist_skipped:
        logger.info("History dedup removed %d papers", hist_skipped)
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
        ctx.emit_activity(f"Launching 4 sub-agents to extract {n} papers...")
        ctx = await _run_sub_agents_parallel(ctx)
        _notify("extraction_sub_agents")
        ctx.emit_activity("Merging extraction results...")
        _merge_sub_results(ctx)
        _notify("extraction_merge")
    else:
        ctx.emit_activity(f"Running unified extraction for {n} papers...")
        ctx = await ExtractionAgent().run_timed(ctx)
        _notify("extraction")

    try:
        await _enrich_with_pubchem(ctx.rows, on_activity=on_activity)
    except Exception as exc:
        logger.warning("PubChem enrichment failed: %s", exc)

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
