"""Shared LLM extraction helper for sub-agents.

Reuses _build_async_client, _chunk_text, _parse_json, _call_with_fallback
from lit_researcher.extract to avoid duplicating LLM logic.
"""

from __future__ import annotations

import asyncio
import logging

from ..extract import (
    _build_async_client,
    _chunk_text,
    _parse_json,
    _call_with_fallback,
    _preprocess_text,
    CHUNK_SIZE,
)
from .. import config

logger = logging.getLogger(__name__)

_AGENT_KEYWORDS: dict[str, list[str]] = {
    "gelma": [
        "gelma", "microsphere", "hydrogel", "methacryl", "crosslink",
        "encapsulation", "particle size", "substitution", "microcarrier",
        "photocrosslinking", "gel fraction",
    ],
    "drug": [
        "drug", "molecular weight", "logp", "pka", "melting", "tpsa",
        "solubility", "partition", "pharmaceutical", "loading",
    ],
    "release": [
        "release", "degradation", "swelling", "ph ", "temperature",
        "cumulative", "burst", "sustained", "diffusion", "erosion",
    ],
}

_FIELD_TO_AGENT: dict[str, str] = {}
for _agent, _kws in _AGENT_KEYWORDS.items():
    if _agent == "gelma":
        for _f in ["gelma_concentration", "degree_of_substitution", "gelma_molecular_weight",
                    "microsphere_size", "drug_microsphere_ratio", "encapsulation_efficiency",
                    "drug_loading_rate", "drug_loading_amount"]:
            _FIELD_TO_AGENT[_f] = _agent
    elif _agent == "drug":
        for _f in ["drug_name", "drug_molecular_weight", "tpsa", "hbd", "hba",
                    "drug_nha", "drug_melting_point", "pka", "drug_logp"]:
            _FIELD_TO_AGENT[_f] = _agent
    elif _agent == "release":
        for _f in ["temperature", "ph", "release_time", "release_amount"]:
            _FIELD_TO_AGENT[_f] = _agent


def _filter_relevant_paragraphs(text: str, fields: list[str]) -> str:
    """Keep only paragraphs relevant to this sub-agent's domain."""
    agent_type = _FIELD_TO_AGENT.get(fields[0], "") if fields else ""
    keywords = _AGENT_KEYWORDS.get(agent_type, [])
    if not keywords:
        return text

    paragraphs = text.split("\n\n")
    if len(paragraphs) <= 3:
        return text

    relevant = [p for p in paragraphs if any(kw in p.lower() for kw in keywords)]
    if len(relevant) < max(3, len(paragraphs) * 0.25):
        return text
    return "\n\n".join(relevant)


async def _extract_chunk(
    text: str,
    title: str,
    doi: str,
    system_prompt: str,
    fields: list[str],
) -> dict:
    """Extract fields from a single text chunk using a sub-agent prompt.

    Uses model fallback chain. Returns all-null on total failure.
    """
    user_msg = f"Paper title: {title}\nDOI: {doi}\n\n---\n\n{text}"
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]

    try:
        raw = await _call_with_fallback(messages, title_hint=title)
    except Exception as e:
        logger.warning("Sub-agent all models failed for '%s': %s", title[:40], e)
        return {f: None for f in fields}

    data = _parse_json(raw)
    if data is None:
        logger.warning("Sub-agent got unparseable JSON for '%s': %s", title[:40], raw[:200] if raw else "(empty)")
        return {f: None for f in fields}

    result = {f: data.get(f) for f in fields}
    if "_confidence" in data and isinstance(data["_confidence"], dict):
        result["_confidence"] = {f: data["_confidence"].get(f) for f in fields}
    return result


async def extract_sub_fields(
    sem: asyncio.Semaphore,
    paper: dict,
    fields: list[str],
    system_prompt: str,
) -> dict:
    """Extract a subset of fields from a paper, with semaphore control.

    Handles text preparation and chunking, reusing existing infrastructure.
    """
    async with sem:
        text = paper.get("text", "")
        title = paper.get("title", "")
        doi = paper.get("doi", "")

        if not text and title:
            text = f"Title: {title}"
            if paper.get("abstract"):
                text += f"\n\nAbstract: {paper['abstract']}"

        if not text:
            return {f: None for f in fields}

        text = _preprocess_text(text)
        text = _filter_relevant_paragraphs(text, fields)

        if len(text) <= CHUNK_SIZE:
            return await _extract_chunk(text, title, doi, system_prompt, fields)

        chunks = _chunk_text(text)
        tasks = [
            _extract_chunk(c, title, doi, system_prompt, fields)
            for c in chunks
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        valid = [r for r in results if isinstance(r, dict)]

        if not valid:
            return {f: None for f in fields}

        merged: dict = {}
        for field in fields:
            best = None
            for r in valid:
                val = r.get(field)
                if val is None:
                    continue
                if best is None or (isinstance(val, str) and len(str(val)) > len(str(best))):
                    best = val
            merged[field] = best
        return merged
