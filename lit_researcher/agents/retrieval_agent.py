"""RetrievalAgent — wraps fetch.fetch_all()."""

from __future__ import annotations

from .base import BaseAgent, PipelineContext
from ..fetch import fetch_all


class RetrievalAgent(BaseAgent):
    name = "RetrievalAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        targets = ctx.failed_papers if ctx.failed_papers and ctx.retry_count > 0 else ctx.papers
        if not targets:
            self._log(ctx, "no papers to fetch")
            return ctx

        results = await fetch_all(
            targets,
            max_concurrent=ctx.fetch_concurrency,
            on_activity=ctx._on_activity,
        )

        if ctx.retry_count > 0 and ctx.papers_with_text:
            existing_by_id = {p.get("paper_id"): i for i, p in enumerate(ctx.papers_with_text)}
            for r in results:
                pid = r.get("paper_id")
                if pid in existing_by_id:
                    old = ctx.papers_with_text[existing_by_id[pid]]
                    if r.get("text") and (not old.get("text") or old.get("text_source") == "none"):
                        ctx.papers_with_text[existing_by_id[pid]] = r
                else:
                    ctx.papers_with_text.append(r)
        else:
            ctx.papers_with_text = list(results)

        fetched = sum(1 for p in ctx.papers_with_text if p.get("text"))
        total = len(ctx.papers_with_text)
        source_counts: dict[str, int] = {}
        for p in ctx.papers_with_text:
            src = p.get("text_source", "unknown")
            source_counts[src] = source_counts.get(src, 0) + 1

        self._log(ctx, f"fetched text for {fetched}/{total} papers, sources: {source_counts}")
        return ctx
