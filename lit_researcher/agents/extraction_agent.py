"""ExtractionAgent — wraps extract.extract_batch()."""

from __future__ import annotations

from .base import BaseAgent, PipelineContext
from ..extract import extract_batch


class ExtractionAgent(BaseAgent):
    name = "ExtractionAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not ctx.passed_papers:
            self._log(ctx, "no papers to extract")
            return ctx

        n = len(ctx.passed_papers)
        ctx.emit_activity(f"开始统一提取 {n} 篇...")
        rows = await extract_batch(
            ctx.passed_papers,
            max_concurrent=ctx.llm_concurrency,
        )
        ctx.rows = list(rows)

        qualities = [r.get("_data_quality", 0) for r in ctx.rows if r.get("_data_quality") is not None]
        avg_q = sum(qualities) / len(qualities) if qualities else 0
        self._log(ctx, f"extracted {len(ctx.rows)} rows, avg quality: {avg_q:.0%}")
        return ctx
