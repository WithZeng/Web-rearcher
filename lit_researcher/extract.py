"""Async LLM extraction with chunking and concurrent batching."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from openai import AsyncOpenAI

from . import config
from .checkpoint import append_result

try:
    from anthropic import AsyncAnthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """You are a scientific literature data extractor specializing in GelMA microsphere drug delivery systems.
Given the text of a research paper, extract ALL of the following fields and return ONLY a JSON object (no markdown, no explanation).

=== GelMA Microsphere Properties ===
- gelma_concentration: GelMA concentration (%, e.g. "5", "10")
- degree_of_substitution: degree of substitution / degree of methacrylation (%, e.g. "60", "80")
- gelma_molecular_weight: GelMA molecular weight in KDa (e.g. "50", "100")
- microsphere_size: microsphere particle size / diameter distribution in μm (e.g. "200-300", "150±20")
- drug_microsphere_ratio: drug-to-microsphere mass ratio / wall ratio (e.g. "1:10", "0.05")
- encapsulation_efficiency: encapsulation efficiency (%, e.g. "85.3")
- drug_loading_rate: drug loading rate / drug loading efficiency (%, e.g. "12.5")
- drug_loading_amount: drug loading amount / capacity (with units, e.g. "50 μg/mg")

=== Drug Characteristics ===
- drug_name: name of the drug / active pharmaceutical ingredient
- drug_molecular_weight: molecular weight of the drug (Da or g/mol) — ONLY if explicitly stated in the paper
- tpsa: topological polar surface area (Å²) — ONLY if explicitly stated in the paper
- hbd: number of hydrogen bond donors — ONLY if explicitly stated in the paper
- hba: number of hydrogen bond acceptors — ONLY if explicitly stated in the paper
- drug_nha: number of heteroatoms — ONLY if explicitly stated in the paper
- drug_melting_point: melting point of the drug (°C) — ONLY if explicitly stated in the paper
- pka: acid dissociation constant (pKa) of the drug — ONLY if explicitly stated in the paper
- drug_logp: calculated partition coefficient (LogP / cLogP) of the drug — ONLY if explicitly stated in the paper

=== Environmental Conditions ===
- temperature: release experiment temperature (°C, e.g. "37")
- ph: pH value(s) used in release experiments (e.g. "7.4", "5.0 and 7.4")
- release_time: total release duration measured (hours, e.g. "72", "168")

=== Target ===
- release_amount: cumulative release amount / percentage (%, e.g. "85.2")

=== Source ===
- source_title: title of the paper
- source_doi: DOI of the paper

IMPORTANT:
- For drug physicochemical properties (drug_molecular_weight, tpsa, hbd, hba, drug_nha, drug_melting_point, pka, drug_logp): ONLY extract values that are EXPLICITLY stated in the paper text. Do NOT fill in reference values or guess based on drug name. Leave as null — these will be auto-filled from PubChem later.
- NEVER fabricate or estimate numeric values. If a value is not explicitly present in the text, you MUST return null for that field.
- For gelma_concentration, microsphere_size, encapsulation_efficiency, drug_loading_rate, release_amount: these MUST come directly from the paper's experimental data. Do not calculate or infer them.
- Use numeric values without units where the unit is already specified in the field name.
- If a field truly cannot be determined, set its value to null.
- Return ONLY valid JSON, nothing else.

Additionally, include a "_confidence" key in your JSON output. Its value should be an object where each key is one of the extraction field names above (excluding source_title and source_doi) and the value is one of:
- "paper"    — the value was explicitly found in the paper text
- "inferred" — the value was reasonably derived from context (NOT allowed for drug_molecular_weight, tpsa, hbd, hba, drug_nha, pka, drug_logp — these must be "paper" or null)
- null       — the field could not be determined at all
Example: "_confidence": {"gelma_concentration": "paper", "drug_name": "paper", "tpsa": null, "pka": null, ...}"""

CHUNK_SIZE = 25_000
CHUNK_OVERLAP = 2_000

_QUALITY_EXCLUDED = {"source_title", "source_doi"}

_REF_MARKERS = re.compile(
    r"\n\s*(References|REFERENCES|Bibliography|BIBLIOGRAPHY|参考文献)\s*\n",
)
_TABLE_PATTERN = re.compile(
    r"(Table\s+\d+[\.\:][\s\S]{20,3000}?)(?=\n\n|\nTable\s+\d+|\nFigure\s+\d+|\Z)",
    re.IGNORECASE,
)


def _preprocess_text(text: str) -> str:
    """Clean and restructure text before sending to LLM.

    1. Strip references section (typically 20-30% of text).
    2. Extract table blocks and prepend them (GelMA data is often in tables).
    3. Truncate to MAX_TEXT_LEN.
    """
    # Strip references — only if marker is in the latter half
    m = None
    for match in _REF_MARKERS.finditer(text):
        if match.start() > len(text) * 0.4:
            m = match
            break
    if m:
        text = text[: m.start()]

    # Extract table sections and prepend
    tables = _TABLE_PATTERN.findall(text)
    if tables:
        table_block = "\n\n".join(f"[TABLE]\n{t.strip()}\n[/TABLE]" for t in tables[:10])
        text = table_block + "\n\n---\n\n" + text

    return text[: config.MAX_TEXT_LEN]


def _build_async_client(api_key: str = "", base_url: str = "", api_type: str = "") -> AsyncOpenAI:
    kwargs = {"api_key": api_key or config.OPENAI_API_KEY}
    url = base_url or config.OPENAI_BASE_URL
    if url:
        kwargs["base_url"] = url
    return AsyncOpenAI(**kwargs)


def _normalize_anthropic_base_url(url: str) -> str:
    """Strip trailing Anthropic API path segments that the SDK appends automatically."""
    url = url.rstrip("/")
    for suffix in ("/v1/messages", "/v1/complete", "/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url


def _build_anthropic_client(api_key: str = "", base_url: str = "") -> "AsyncAnthropic":
    if not HAS_ANTHROPIC:
        raise ImportError("anthropic package is not installed. Run: pip install anthropic")
    key = api_key or config.OPENAI_API_KEY
    kwargs: dict = {"api_key": key}
    if base_url:
        kwargs["base_url"] = _normalize_anthropic_base_url(base_url)
        # Relay/proxy stations typically expect Bearer auth instead of x-api-key
        kwargs["default_headers"] = {"Authorization": f"Bearer {key}"}
    return AsyncAnthropic(**kwargs)


async def _call_anthropic(client: "AsyncAnthropic", model: str, messages: list[dict]) -> str:
    system_msg = ""
    user_messages = []
    for m in messages:
        if m["role"] == "system":
            system_msg = m["content"]
        else:
            user_messages.append(m)
    # Prefill assistant with '{' to force JSON output from Claude
    user_messages.append({"role": "assistant", "content": "{"})
    kwargs: dict = {"model": model, "max_tokens": 8192, "temperature": 0, "messages": user_messages}
    if system_msg:
        kwargs["system"] = system_msg
    resp = await client.messages.create(**kwargs)
    parts = ["{"]
    for block in resp.content:
        if hasattr(block, "text"):
            parts.append(block.text)
    return "".join(parts)


def _get_model_chain() -> list[dict]:
    """Return a list of model configs to try in order: primary first, then fallbacks."""
    from .ui_helpers import load_models

    primary = {
        "api_key": config.OPENAI_API_KEY,
        "base_url": config.OPENAI_BASE_URL,
        "model": config.OPENAI_MODEL,
        "api_type": config.API_TYPE,
        "name": "primary",
    }
    chain = [primary]
    for m in load_models():
        if m.get("api_key") and (m.get("model") or m.get("model_name")):
            model_name = m.get("model") or m.get("model_name", "")
            if m["api_key"] == primary["api_key"] and model_name == primary["model"]:
                continue
            chain.append({
                "api_key": m["api_key"],
                "base_url": m.get("base_url", ""),
                "model": model_name,
                "api_type": m.get("api_type", "openai"),
                "name": m.get("name", model_name),
            })
    return chain


def _chunk_text(text: str) -> list[str]:
    """Split text into overlapping chunks if it exceeds CHUNK_SIZE."""
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start = end - CHUNK_OVERLAP
    return chunks


def _parse_json(raw: str) -> dict | None:
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("```"):
        lines = raw.split("\n", 1)
        raw = (lines[1] if len(lines) > 1 else raw).strip()
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    brace_start = raw.find("{")
    brace_end = raw.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        candidate = raw[brace_start:brace_end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _merge_chunk_results(results: list[dict]) -> dict:
    """Merge multiple chunk extractions: prefer non-null, longer values."""
    merged: dict = {}
    for field in config.FIELDS:
        best = None
        for r in results:
            val = r.get(field)
            if val is None:
                continue
            if best is None or (isinstance(val, str) and len(str(val)) > len(str(best))):
                best = val
        merged[field] = best

    merged_conf: dict = {}
    for field in config.FIELDS:
        if field in _QUALITY_EXCLUDED:
            continue
        best_src = None
        for r in results:
            conf = r.get("_confidence", {}) or {}
            src = conf.get(field)
            if src is None:
                continue
            if best_src is None or src == "paper":
                best_src = src
        merged_conf[field] = best_src
    merged["_confidence"] = merged_conf

    return merged


def _compute_data_quality(data: dict) -> float:
    """Fraction of non-null extraction fields (excluding source & meta keys)."""
    scorable = [
        f for f in config.FIELDS
        if f not in _QUALITY_EXCLUDED and not f.startswith("_")
    ]
    if not scorable:
        return 0.0
    filled = sum(1 for f in scorable if data.get(f) is not None)
    return round(filled / len(scorable), 4)


async def _call_llm_stream(client: AsyncOpenAI, model: str, messages: list[dict]) -> str:
    """Streaming call -- workaround for proxies returning content=null."""
    stream = await client.chat.completions.create(
        model=model,
        temperature=0,
        messages=messages,
        stream=True,
    )
    chunks: list[str] = []
    async for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            chunks.append(delta.content)
    return "".join(chunks)


class LLMAllFailedError(Exception):
    """Raised when every model in the fallback chain fails."""


_LLM_CALL_TIMEOUT = 120  # seconds per model attempt


async def _call_with_fallback(messages: list[dict], title_hint: str = "") -> str:
    """Try the primary model, then fall back to configured alternatives."""
    chain = _get_model_chain()
    last_err: Exception | None = None

    for i, m in enumerate(chain):
        model = m["model"]
        api_type = m.get("api_type", "openai")
        try:
            if api_type == "anthropic":
                client_a = _build_anthropic_client(api_key=m["api_key"], base_url=m["base_url"])
                raw = await asyncio.wait_for(
                    _call_anthropic(client_a, model, messages),
                    timeout=_LLM_CALL_TIMEOUT,
                )
            else:
                client = _build_async_client(api_key=m["api_key"], base_url=m["base_url"])
                # Try with JSON mode first; fall back without it if unsupported
                try:
                    resp = await asyncio.wait_for(
                        client.chat.completions.create(
                            model=model, temperature=0, messages=messages,
                            response_format={"type": "json_object"},
                        ),
                        timeout=_LLM_CALL_TIMEOUT,
                    )
                except Exception:
                    resp = await asyncio.wait_for(
                        client.chat.completions.create(
                            model=model, temperature=0, messages=messages,
                        ),
                        timeout=_LLM_CALL_TIMEOUT,
                    )
                raw = resp.choices[0].message.content or ""
                if not raw.strip():
                    raw = await asyncio.wait_for(
                        _call_llm_stream(client, model, messages),
                        timeout=_LLM_CALL_TIMEOUT,
                    )
            if raw.strip():
                if i > 0:
                    logger.info("Fallback to model '%s' succeeded for '%s'", m["name"], title_hint[:40])
                return raw
            logger.warning("Model '%s' returned empty response for '%s', trying next", m["name"], title_hint[:40])
        except asyncio.TimeoutError:
            last_err = TimeoutError(f"Model '{m['name']}' timed out after {_LLM_CALL_TIMEOUT}s")
            logger.warning("Model '%s' timed out for '%s'", m["name"], title_hint[:40])
        except Exception as e:
            last_err = e
            logger.warning("Model '%s' failed for '%s': %s", m["name"], title_hint[:40], e)

    raise LLMAllFailedError(str(last_err) if last_err else "All models returned empty")


async def _extract_single_chunk(client: AsyncOpenAI | None, text: str, title: str, doi: str) -> dict:
    """Extract fields from a single text chunk.

    Uses model fallback chain: tries primary model first, then alternatives.
    Returns all-null with ``_skip_reason`` if every model fails.
    """
    user_msg = f"Paper title: {title}\nDOI: {doi}\n\n---\n\n{text}"
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]

    try:
        raw = await _call_with_fallback(messages, title_hint=title)
    except LLMAllFailedError as e:
        logger.warning("All LLM models failed for '%s': %s", title[:40], e)
        result = {f: None for f in config.FIELDS}
        result["_skip_reason"] = f"API 错误: {e}"
        return result
    except Exception as e:
        logger.warning("Unexpected error for '%s': %s", title[:40], e)
        result = {f: None for f in config.FIELDS}
        result["_skip_reason"] = f"未知错误: {e}"
        return result

    data = _parse_json(raw)
    if data is None:
        logger.warning("LLM returned unparseable JSON for '%s': %s", title[:40], raw[:200])
        result = {f: None for f in config.FIELDS}
        result["_skip_reason"] = "LLM 返回格式错误（非 JSON）"
        return result
    return data


async def extract_fields(text: str, title: str = "", doi: str = "") -> dict:
    """Extract fields, chunking if text is long. Uses model fallback chain."""
    text = _preprocess_text(text)
    client = _build_async_client()
    chunks = _chunk_text(text)

    if len(chunks) == 1:
        data = await _extract_single_chunk(client, chunks[0], title, doi)
    else:
        logger.info("Splitting into %d chunks for: %s", len(chunks), title[:50])
        tasks = [_extract_single_chunk(client, c, title, doi) for c in chunks]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        valid = [r for r in results if isinstance(r, dict)]
        data = _merge_chunk_results(valid) if valid else {f: None for f in config.FIELDS}

    if not data.get("source_title"):
        data["source_title"] = title
    if not data.get("source_doi"):
        data["source_doi"] = doi

    return data


def _verify_values(row: dict, source_text: str) -> dict:
    """Cross-check extracted values against source text.

    If a value actually appears in the source, mark confidence as "paper".
    If LLM claimed "paper" but value is absent, downgrade to "inferred".
    """
    if not source_text:
        return row
    text_lower = source_text.lower()
    confidence = row.get("_confidence") or {}
    if not isinstance(confidence, dict):
        confidence = {}

    for field in config.FIELDS:
        if field in _QUALITY_EXCLUDED:
            continue
        val = row.get(field)
        if val is None:
            continue
        val_str = str(val).strip()
        if not val_str:
            continue
        if val_str.lower() in text_lower:
            confidence[field] = "paper"
        elif confidence.get(field) == "paper":
            confidence[field] = "inferred"

    row["_confidence"] = confidence
    return row


async def extract_one(
    sem: asyncio.Semaphore,
    paper: dict,
    save_checkpoint: bool = True,
) -> dict:
    """Extract fields for one paper with semaphore control."""
    async with sem:
        text = paper.get("text", "")
        title = paper.get("title", "")
        doi = paper.get("doi", "")

        if not text and title:
            text = f"Title: {title}"
            if paper.get("abstract"):
                text += f"\n\nAbstract: {paper['abstract']}"

        text_too_short = text and len(text.strip()) < 100

        if not text:
            logger.debug("Skipping %s: no text or title available", title[:40])
            data = {f: None for f in config.FIELDS}
            data["source_title"] = title
            data["source_doi"] = doi
            data["_skip_reason"] = "无可用文本（未获取到全文或摘要）"
            data["_confidence"] = {
                f: None for f in config.FIELDS if f not in _QUALITY_EXCLUDED
            }
        elif text_too_short:
            logger.debug("Text too short for %s (%d chars)", title[:40], len(text))
            data = await extract_fields(text, title=title, doi=doi)
            if data.get("_data_quality", 0) == 0 or all(data.get(f) is None for f in config.FIELDS if f not in _QUALITY_EXCLUDED):
                data["_skip_reason"] = f"文本过短（仅 {len(text)} 字符），提取数据不足"
        else:
            data = await extract_fields(text, title=title, doi=doi)

        drug_name = data.get("drug_name")
        if drug_name and str(drug_name).strip():
            try:
                from .pubchem import lookup_drug, enrich_row
                pubchem_data = await lookup_drug(str(drug_name))
                if pubchem_data:
                    n_filled = enrich_row(data, pubchem_data)
                    if n_filled:
                        logger.info("PubChem enriched %d fields for '%s'", n_filled, title[:40])
            except Exception as e:
                logger.debug("PubChem enrichment skipped for '%s': %s", title[:40], e)

        _verify_values(data, paper.get("text", ""))

        data["_data_quality"] = _compute_data_quality(data)
        data["paper_id"] = paper.get("paper_id", "")

        if paper.get("text_source"):
            data["text_source"] = paper["text_source"]

        if save_checkpoint:
            append_result(data)

        return data


async def extract_batch(
    papers_with_text: list[dict],
    max_concurrent: int | None = None,
) -> list[dict]:
    """Concurrently extract fields from all papers.

    Individual extraction failures return all-null rows instead of
    crashing the entire batch.
    """
    max_concurrent = max_concurrent or config.LLM_CONCURRENCY
    sem = asyncio.Semaphore(max_concurrent)
    tasks = [extract_one(sem, p) for p in papers_with_text]
    raw = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[dict] = []
    for i, r in enumerate(raw):
        if isinstance(r, Exception):
            logger.warning("extract_one failed for paper %d: %s", i, r)
            fallback = {f: None for f in config.FIELDS}
            fallback["source_title"] = papers_with_text[i].get("title", "")
            fallback["source_doi"] = papers_with_text[i].get("doi", "")
            fallback["_data_quality"] = 0.0
            fallback["_skip_reason"] = f"提取异常: {r}"
            results.append(fallback)
        else:
            results.append(r)
    return results


async def extract_batch_with_progress(
    papers_with_text: list[dict],
    on_complete: Callable[[int, int, dict], None] | None = None,
    max_concurrent: int | None = None,
) -> list[dict]:
    """Concurrently extract with per-paper completion callback.

    *on_complete(done_count, total, result)* is called each time a paper
    finishes, allowing the caller to update a progress bar.
    """
    max_concurrent = max_concurrent or config.LLM_CONCURRENCY
    sem = asyncio.Semaphore(max_concurrent)
    total = len(papers_with_text)

    async def _tracked(idx: int, paper: dict) -> tuple[int, dict]:
        result = await extract_one(sem, paper, save_checkpoint=False)
        return idx, result

    tasks = [asyncio.ensure_future(_tracked(i, p)) for i, p in enumerate(papers_with_text)]

    results: list[dict | None] = [None] * total
    done_count = 0
    for coro in asyncio.as_completed(tasks):
        idx, result = await coro
        results[idx] = result
        done_count += 1
        if on_complete:
            on_complete(done_count, total, result)

    return [r for r in results if r is not None]
