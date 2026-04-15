"""DrugAgent — extract drug physicochemical property fields."""

from __future__ import annotations

import asyncio

from .base import BaseAgent, PipelineContext
from .sub_extract import extract_sub_fields

DRUG_FIELDS = [
    "drug_name",
    "drug_molecular_weight",
    "tpsa",
    "hbd",
    "hba",
    "drug_nha",
    "drug_melting_point",
    "pka",
    "drug_logp",
]

_DRUG_PROMPT = """You are a scientific data extractor. From the given paper text, extract ONLY the following drug property fields.
Return a JSON object with these keys (set value to null if not found):

- drug_name: name of the drug / active pharmaceutical ingredient
- drug_molecular_weight: molecular weight of the drug (Da or g/mol) — ONLY if explicitly stated in the paper
- tpsa: topological polar surface area (Å²) — ONLY if explicitly stated in the paper
- hbd: number of hydrogen bond donors — ONLY if explicitly stated in the paper
- hba: number of hydrogen bond acceptors — ONLY if explicitly stated in the paper
- drug_nha: number of heteroatoms — ONLY if explicitly stated in the paper
- drug_melting_point: melting point of the drug (°C) — ONLY if explicitly stated in the paper
- pka: acid dissociation constant (pKa) of the drug — ONLY if explicitly stated in the paper
- drug_logp: calculated partition coefficient (LogP / cLogP) of the drug — ONLY if explicitly stated in the paper

IMPORTANT:
- Do NOT fill in reference values or guess based on drug name. Leave as null — PubChem will auto-fill these later.
- NEVER fabricate or estimate numeric values. If a value is not explicitly present in the text, return null.
Additionally, include a "_confidence" key: an object where each field name maps to "paper" (explicitly found in the text), or null (not found). "inferred" is NOT allowed for drug_molecular_weight, tpsa, hbd, hba, drug_nha, pka, drug_logp.
Return ONLY valid JSON, nothing else."""


class DrugAgent(BaseAgent):
    name = "DrugAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not ctx.passed_papers:
            self._log(ctx, "no papers to extract")
            return ctx

        n = len(ctx.passed_papers)
        ctx.emit_activity(f"药物特征提取 [0/{n}]...")
        sem = asyncio.Semaphore(ctx.llm_concurrency)

        async def _tracked(i: int, paper: dict) -> dict:
            ctx.emit_activity(f"药物特征提取 [{i + 1}/{n}] {paper.get('title', '?')[:35]}...")
            return await extract_sub_fields(sem, paper, DRUG_FIELDS, _DRUG_PROMPT)

        tasks = [_tracked(i, p) for i, p in enumerate(ctx.passed_papers)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        ctx._drug_results = [
            r if isinstance(r, dict) else {f: None for f in DRUG_FIELDS}
            for r in results
        ]
        self._log(ctx, f"extracted {len(ctx._drug_results)} drug records")
        return ctx
