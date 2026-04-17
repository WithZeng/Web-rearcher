"""SearchAgent -- wraps search.search_papers_with_stats()."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from ..search import (
    search_papers_with_stats,
    search_papers_rolling_with_stats,
    _normalize_doi_key,
    _normalize_title_key,
)


class SearchAgent(BaseAgent):
    name = "SearchAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.rolling_mode:
            papers, stats, cursor_state, exhausted_sources = await asyncio.to_thread(
                search_papers_rolling_with_stats,
                ctx.query,
                ctx.max_unique_candidates or ctx.limit,
                ctx.databases,
                round_number=ctx.search_round,
                seen_doi_keys=ctx.seen_doi_keys,
                seen_title_keys=ctx.seen_title_keys,
                per_db_cursor_state=ctx.search_cursor_state,
                current_unique_count=len(ctx.candidate_pool),
                desired_new_candidates=ctx.desired_new_candidates,
                on_db_done=lambda db, n: ctx.emit_activity(f"{db} round {ctx.search_round} search complete, got {n} papers"),
            )
            ctx.search_cursor_state = cursor_state
            ctx.sources_exhausted = exhausted_sources
            previous_raw = int(ctx._search_stats.get("raw_count") or 0)
            current_unique_total = len(ctx.candidate_pool) + len(papers)
            ctx._search_stats = {
                "requested_limit": ctx.max_unique_candidates or ctx.limit,
                "per_db_limit": stats.get("per_db_limit", 0),
                "db_counts": stats.get("db_counts") or {},
                "raw_count": previous_raw + int(stats.get("raw_count") or 0),
                "deduped_count": current_unique_total,
                "returned_count": current_unique_total,
                "database_count": stats.get("database_count") or len(ctx.databases),
                "round_number": ctx.search_round,
                "round_raw_count": int(stats.get("raw_count") or 0),
                "round_deduped_count": int(stats.get("deduped_count") or 0),
                "round_returned_count": int(stats.get("returned_count") or 0),
                "exhausted_sources": exhausted_sources,
            }
        else:
            papers, stats = await asyncio.to_thread(
                search_papers_with_stats,
                ctx.query,
                limit=ctx.limit,
                databases=ctx.databases,
                on_db_done=lambda db, n: ctx.emit_activity(f"{db} search complete, got {n} papers"),
            )
            ctx._search_stats = stats

        ctx.papers = papers
        if ctx.rolling_mode:
            for paper in papers:
                doi_key = _normalize_doi_key(str(paper.get("doi") or ""))
                title_key = _normalize_title_key(str(paper.get("title") or ""))
                if doi_key:
                    ctx.seen_doi_keys.add(doi_key)
                if title_key:
                    ctx.seen_title_keys.add(title_key)
        self._log(ctx, f"found {len(papers)} papers (query={ctx.query!r}, dbs={ctx.databases})")
        return ctx
