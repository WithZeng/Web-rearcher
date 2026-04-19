"""ReleaseAgent — extract environmental conditions and release result fields."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from .sub_extract import extract_sub_fields

RELEASE_FIELDS = [
    "temperature",
    "ph",
    "release_time",
    "release_amount",
]

_RELEASE_PROMPT = """You are a scientific data extractor. From the given paper text, extract ONLY the following release experiment fields.
Return a JSON object with these keys (set value to null if not found, do NOT guess).
Your goal is precision over recall: if a value is related but not clearly the exact release-experiment field, return null.

- temperature: release experiment temperature (C, e.g. "37")
- ph: pH value(s) used in release experiments (e.g. "7.4", "5.0 and 7.4")
- release_time: total release duration measured (hours, e.g. "72", "168")
- release_amount: cumulative release amount / percentage (%, e.g. "85.2")

Rules:
- These fields must come from the drug release experiment itself.
- Do NOT use degradation time, swelling time, incubation time, culture time, storage time, gelation time, or crosslinking time as release_time.
- Do NOT use drug loading amount, remaining drug amount, degradation percentage, or biological response metrics as release_amount.
- Do NOT use synthesis conditions, storage conditions, or cell culture conditions as temperature/ph unless the paper explicitly states they are the release-test conditions.
- For temperature, ph, release_time, and release_amount, "inferred" is not allowed. Use only "paper" or null.

Use numeric values without units where the unit is already specified in the field name.
Additionally, include a "_confidence" key: an object where each field name maps to "paper" (explicitly found), "inferred", or null (not found).
Return ONLY valid JSON, nothing else."""


class ReleaseAgent(BaseAgent):
    name = "ReleaseAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not ctx.passed_papers:
            self._log(ctx, "no papers to extract")
            return ctx

        n = len(ctx.passed_papers)
        ctx.emit_activity(f"释放数据提取 [0/{n}]...")
        sem = asyncio.Semaphore(ctx.llm_concurrency)

        async def _tracked(i: int, paper: dict) -> dict:
            ctx.emit_activity(f"释放数据提取 [{i + 1}/{n}] {paper.get('title', '?')[:35]}...")
            return await extract_sub_fields(sem, paper, RELEASE_FIELDS, _RELEASE_PROMPT)

        tasks = [_tracked(i, p) for i, p in enumerate(ctx.passed_papers)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        ctx._release_results = [
            r if isinstance(r, dict) else {f: None for f in RELEASE_FIELDS}
            for r in results
        ]
        self._log(ctx, f"extracted {len(ctx._release_results)} release records")
        return ctx
