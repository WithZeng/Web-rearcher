"""GelmaAgent — extract GelMA microsphere property fields."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from .sub_extract import extract_sub_fields

GELMA_FIELDS = [
    "gelma_concentration",
    "degree_of_substitution",
    "gelma_molecular_weight",
    "microsphere_size",
    "drug_microsphere_ratio",
    "encapsulation_efficiency",
    "drug_loading_rate",
    "drug_loading_amount",
]

_GELMA_PROMPT = """You are a scientific data extractor. From the given paper text, extract ONLY the following GelMA microsphere fields.
Return a JSON object with these keys (set value to null if not found, do NOT guess):

- gelma_concentration: GelMA concentration (%, e.g. "5", "10")
- degree_of_substitution: degree of substitution / degree of methacrylation (%, e.g. "60", "80")
- gelma_molecular_weight: GelMA molecular weight in KDa (e.g. "50", "100")
- microsphere_size: microsphere particle size / diameter distribution in um (e.g. "200-300", "150+/-20")
- drug_microsphere_ratio: drug-to-microsphere mass ratio (e.g. "1:10", "0.05")
- encapsulation_efficiency: encapsulation efficiency (%, e.g. "85.3")
- drug_loading_rate: drug loading rate (%, e.g. "12.5")
- drug_loading_amount: drug loading amount with units (e.g. "50 ug/mg")

Additionally, include a "_confidence" key: an object where each field name maps to "paper" (explicitly found), "inferred", or null (not found).
Return ONLY valid JSON, nothing else."""


class GelmaAgent(BaseAgent):
    name = "GelmaAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not ctx.passed_papers:
            self._log(ctx, "no papers to extract")
            return ctx

        n = len(ctx.passed_papers)
        ctx.emit_activity(f"GelMA 提取 [0/{n}]...")
        sem = asyncio.Semaphore(ctx.llm_concurrency)

        async def _tracked(i: int, paper: dict) -> dict:
            ctx.emit_activity(f"GelMA 提取 [{i + 1}/{n}] {paper.get('title', '?')[:35]}...")
            return await extract_sub_fields(sem, paper, GELMA_FIELDS, _GELMA_PROMPT)

        tasks = [_tracked(i, p) for i, p in enumerate(ctx.passed_papers)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        ctx._gelma_results = [
            r if isinstance(r, dict) else {f: None for f in GELMA_FIELDS}
            for r in results
        ]
        self._log(ctx, f"extracted {len(ctx._gelma_results)} gelma records")
        return ctx
