"""PlannerAgent — uses LLM to decide search strategy from the user query."""

from __future__ import annotations

import json
import logging

from .base import BaseAgent, PipelineContext
from .. import config
from ..extract import _call_with_fallback

logger = logging.getLogger(__name__)

_PLANNER_PROMPT = """You are a search strategy planner for academic literature retrieval.
Given a user query about scientific research, decide the optimal search strategy.

Available databases: {databases}
User's requested limit: {limit}

Analyze the query and return a JSON object with:
- "databases": list of database names to search (pick the most relevant 2-4 from the available list)
- "limit": recommended number of papers (use the user's limit unless you think it should be adjusted)
- "reasoning": one sentence explaining your strategy

Rules:
- For biomedical topics: prioritize PubMed, OpenAlex
- For materials/chemistry: prioritize CrossRef, OpenAlex
- For CS/AI topics: prioritize arXiv, Semantic Scholar
- For broad queries: use OpenAlex + CrossRef + one domain-specific DB
- Always include OpenAlex (best coverage)
- Return ONLY valid JSON, nothing else."""


class PlannerAgent(BaseAgent):
    name = "PlannerAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        if not config.OPENAI_API_KEY:
            self._log(ctx, "skipped (no API key), using defaults")
            return ctx

        prompt = _PLANNER_PROMPT.format(
            databases=", ".join(config.ALL_DATABASES),
            limit=ctx.limit,
        )

        try:
            messages = [
                {"role": "system", "content": prompt},
                {"role": "user", "content": ctx.query},
            ]
            raw = await _call_with_fallback(messages, title_hint="planner")

            raw = raw.strip()
            if raw.startswith("```"):
                lines = raw.split("\n", 1)
                raw = lines[1] if len(lines) > 1 else raw
                if raw.endswith("```"):
                    raw = raw[:-3].strip()

            plan = json.loads(raw)

            suggested_dbs = plan.get("databases", [])
            valid_dbs = [db for db in suggested_dbs if db in config.ALL_DATABASES]
            if valid_dbs:
                ctx.databases = valid_dbs

            suggested_limit = plan.get("limit")
            if isinstance(suggested_limit, int) and suggested_limit > 0:
                ctx.limit = suggested_limit

            reasoning = plan.get("reasoning", "")
            self._log(ctx, f"strategy: dbs={ctx.databases}, limit={ctx.limit}, reason={reasoning}")

        except Exception as e:
            self._log(ctx, f"LLM planning failed ({e}), using defaults")

        return ctx
