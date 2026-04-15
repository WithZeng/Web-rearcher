"""SourceAgent — extract paper source/bibliographic fields."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from .sub_extract import extract_sub_fields

SOURCE_FIELDS = [
    "source_title",
    "source_doi",
]

_SOURCE_PROMPT = """You are a scientific data extractor. From the given paper text, extract ONLY the following source fields.
Return a JSON object with these keys (set value to null if not found):

- source_title: title of the paper
- source_doi: DOI of the paper

Return ONLY valid JSON, nothing else."""


class SourceAgent(BaseAgent):
    name = "SourceAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not ctx.passed_papers:
            self._log(ctx, "no papers to extract")
            return ctx

        n = len(ctx.passed_papers)
        ctx.emit_activity(f"来源信息提取 [0/{n}]...")
        sem = asyncio.Semaphore(ctx.llm_concurrency)

        async def _tracked(i: int, paper: dict) -> dict:
            ctx.emit_activity(f"来源信息提取 [{i + 1}/{n}] {paper.get('title', '?')[:35]}...")
            return await extract_sub_fields(sem, paper, SOURCE_FIELDS, _SOURCE_PROMPT)

        tasks = [_tracked(i, p) for i, p in enumerate(ctx.passed_papers)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        ctx._source_results = [
            r if isinstance(r, dict) else {f: None for f in SOURCE_FIELDS}
            for r in results
        ]

        for i, paper in enumerate(ctx.passed_papers):
            result = ctx._source_results[i]
            if not result.get("source_title"):
                result["source_title"] = paper.get("title", "")
            if not result.get("source_doi"):
                result["source_doi"] = paper.get("doi", "")

        self._log(ctx, f"extracted {len(ctx._source_results)} source records")
        return ctx
