"""SearchAgent — wraps search.search_papers()."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from ..search import search_papers


class SearchAgent(BaseAgent):
    name = "SearchAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        papers = await asyncio.to_thread(
            search_papers,
            ctx.query,
            limit=ctx.limit,
            databases=ctx.databases,
            on_db_done=lambda db, n: ctx.emit_activity(f"{db} 检索完成，获得 {n} 篇"),
        )
        ctx.papers = papers
        self._log(ctx, f"found {len(papers)} papers (query={ctx.query!r}, dbs={ctx.databases})")
        return ctx
