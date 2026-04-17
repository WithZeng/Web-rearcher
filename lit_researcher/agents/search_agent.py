"""SearchAgent -- wraps search.search_papers_with_stats()."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from ..search import search_papers_with_stats


class SearchAgent(BaseAgent):
    name = "SearchAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        papers, stats = await asyncio.to_thread(
            search_papers_with_stats,
            ctx.query,
            limit=ctx.limit,
            databases=ctx.databases,
            on_db_done=lambda db, n: ctx.emit_activity(f"{db} search complete, got {n} papers"),
        )
        ctx.papers = papers
        ctx._search_stats = stats
        self._log(ctx, f"found {len(papers)} papers (query={ctx.query!r}, dbs={ctx.databases})")
        return ctx
