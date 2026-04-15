"""Orchestrator — drives the multi-agent pipeline.

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
from ..extract import _compute_data_quality
from ..checkpoint import filter_unprocessed
from .base import PipelineContext
from .planner import PlannerAgent
from .search_agent import SearchAgent
from .retrieval_agent import RetrievalAgent
from .quality_filter import QualityFilterAgent
from .extraction_agent import ExtractionAgent
from .reviewer import ReviewerAgent
from .gelma_agent import GelmaAgent
from .drug_agent import DrugAgent
from .release_agent import ReleaseAgent
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
    """Merge results from 4 sub-extraction agents into ctx.rows.

    When multiple sub-agents return a value for the same field (shouldn't
    normally happen since fields are disjoint), pick the longer string.
    Also merges _confidence dicts from all sub-agents.
    """
    n = len(ctx.passed_papers)
    rows: list[dict] = []

    for i in range(n):
        merged: dict = {}
        merged_conf: dict = {}

        for sub in [ctx._gelma_results, ctx._drug_results,
                     ctx._release_results, ctx._source_results]:
            if i < len(sub):
                for k, v in sub[i].items():
                    if k == "_confidence" and isinstance(v, dict):
                        for ck, cv in v.items():
                            if cv is not None and (merged_conf.get(ck) is None or cv == "paper"):
                                merged_conf[ck] = cv
                        continue
                    merged[k] = _pick_best_value(merged.get(k), v)

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
    for r in rows:
        name = str(r.get("drug_name") or "").strip()
        if name:
            drug_names.add(name)

    if not drug_names:
        return

    if on_activity:
        on_activity(f"正在从 PubChem 查询 {len(drug_names)} 种药物的化学性质...")

    cache, pc_stats = await batch_lookup(drug_names)

    if on_activity and pc_stats.get("cache_hit"):
        on_activity(f"PubChem 缓存命中 {pc_stats['cache_hit']} 种，查询 {pc_stats['queried']} 种")

    total_filled = 0
    for r in rows:
        name = str(r.get("drug_name") or "").strip()
        if name and name in cache and cache[name]:
            n = enrich_row(r, cache[name])
            if n:
                total_filled += n
                r["_data_quality"] = _compute_data_quality(r)

    if total_filled:
        logger.info("PubChem enriched %d fields across %d drugs", total_filled, len([d for d in cache.values() if d]))
        if on_activity:
            on_activity(f"PubChem 补全了 {total_filled} 个字段")


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

    for r in results:
        if isinstance(r, Exception):
            logger.warning("Sub-agent failed: %s", r)

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
    """Run the full pipeline and return reviewed rows.

    Parameters
    ----------
    mode : str
        "single" for unified ExtractionAgent, "multi" for 4 sub-agents.
    on_activity : callable | None
        Fine-grained activity callback for real-time UI updates.
    resume : bool
        If True, skip papers already in the checkpoint file.
    pause_after_filter : callable | None
        If provided, called after QualityFilter with ``(ctx)``.
        Return ``False`` to abort the pipeline (skip extraction).
    cancel_check : callable | None
        Called between stages; should raise to abort the pipeline.
    """
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

    # 1. Planner (optional)
    if use_planner:
        ctx.emit_activity("正在生成检索策略...")
        ctx = await PlannerAgent().run_timed(ctx)
        _notify("planner")

    # 2. Search
    db_names = ", ".join(ctx.databases)
    ctx.emit_activity(f"正在搜索 {db_names}...")
    ctx = await SearchAgent().run_timed(ctx)
    _notify("search")
    if not ctx.papers:
        logger.warning("No papers found for query: %s", query)
        return []

    ctx.emit_activity(f"检索到 {len(ctx.papers)} 篇文献")

    # 2b. Resume: skip already-processed papers
    if resume:
        ctx.papers = filter_unprocessed(ctx.papers)
        if not ctx.papers:
            logger.info("Resume: all papers already processed")
            return []

    # 2c. Blacklist: skip DOIs that previously failed to fetch
    from ..blacklist import filter_blacklisted
    before_bl = len(ctx.papers)
    ctx.papers = filter_blacklisted(ctx.papers)
    if len(ctx.papers) < before_bl:
        skipped = before_bl - len(ctx.papers)
        ctx.emit_activity(f"跳过 {skipped} 个黑名单 DOI，剩余 {len(ctx.papers)} 篇")
        logger.info("Blacklist removed %d papers", skipped)

    # 2d. History dedup: skip papers already in previous task results
    from ..ui_helpers import filter_history_duplicates
    ctx.papers, hist_skipped = filter_history_duplicates(ctx.papers)
    if hist_skipped:
        ctx.emit_activity(f"跳过 {hist_skipped} 篇已检索文献，剩余 {len(ctx.papers)} 篇")
        logger.info("History dedup removed %d papers", hist_skipped)
    if not ctx.papers:
        logger.info("All papers already in history")
        return []

    # 3. Retrieval
    ctx.emit_activity(f"开始获取 {len(ctx.papers)} 篇全文...")
    ctx = await RetrievalAgent().run_timed(ctx)
    _notify("retrieval")

    # 4. Quality filter
    ctx.emit_activity(f"正在评估 {len(ctx.papers_with_text)} 篇文献质量...")
    ctx = await QualityFilterAgent().run_timed(ctx)
    _notify("quality_filter")
    ctx.emit_activity(f"质量筛选完成：{len(ctx.passed_papers)} 篇通过，{len(ctx.failed_papers)} 篇未通过")

    # 4b. Retry loop for failed papers
    for attempt in range(max_retries):
        if not ctx.failed_papers:
            break
        ctx.retry_count += 1
        ctx.emit_activity(f"重试第 {ctx.retry_count} 轮：重新获取 {len(ctx.failed_papers)} 篇...")
        logger.info("Retry %d: re-fetching %d failed papers", ctx.retry_count, len(ctx.failed_papers))
        ctx = await RetrievalAgent().run_timed(ctx)
        ctx = await QualityFilterAgent().run_timed(ctx)
        _notify("quality_filter")

    # 4c. Optional pause for preview
    if pause_after_filter:
        should_continue = pause_after_filter(ctx)
        if not should_continue:
            logger.info("Pipeline paused by user after quality filter")
            return []

    # 5. Extraction
    n = len(ctx.passed_papers)
    if mode == "multi":
        ctx.emit_activity(f"启动 4 个子智能体并行提取 {n} 篇...")
        ctx = await _run_sub_agents_parallel(ctx)
        _notify("extraction_sub_agents")
        ctx.emit_activity("正在合并提取结果...")
        _merge_sub_results(ctx)
        _notify("extraction_merge")
    else:
        ctx.emit_activity(f"开始统一提取 {n} 篇...")
        ctx = await ExtractionAgent().run_timed(ctx)
        _notify("extraction")

    # 5b. PubChem enrichment
    try:
        await _enrich_with_pubchem(ctx.rows, on_activity=on_activity)
    except Exception as e:
        logger.warning("PubChem enrichment failed: %s", e)

    # 6. Review
    ctx.emit_activity(f"正在审查 {len(ctx.rows)} 条提取结果...")
    ctx = await ReviewerAgent().run_timed(ctx)
    _notify("reviewer")

    # 6b. Reviewer-driven retry for suspicious rows
    if ctx._retry_queue and ctx.retry_count < max_retries + 1:
        ctx.emit_activity(f"审查发现 {len(ctx._retry_queue)} 条可疑数据，正在重新提取...")
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

        retry_ctx.rows = retry_ctx.rows
        retry_ctx = await ReviewerAgent().run_timed(retry_ctx)

        retry_dois = {r.get("source_doi") for r in retry_ctx.reviewed_rows if r.get("source_doi")}
        kept = [r for r in ctx.reviewed_rows if r.get("source_doi") not in retry_dois]
        ctx.reviewed_rows = kept + retry_ctx.reviewed_rows
        _notify("reviewer_retry")

    logger.info(
        "Pipeline complete (%s mode): %d reviewed rows, %d logs",
        mode, len(ctx.reviewed_rows), len(ctx.logs),
    )
    return ctx.reviewed_rows
