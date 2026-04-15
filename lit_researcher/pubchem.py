"""PubChem API integration for auto-filling drug physicochemical properties.

When the LLM fails to extract drug properties (TPSA, HBD, HBA, LogP, etc.)
but successfully identifies the drug name, this module queries PubChem to
fill in the missing values from authoritative reference data.

Query results are persisted to ``output/pubchem_cache.json`` so that
restarting the server or switching tasks never re-queries the same drug.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import quote

import aiohttp

logger = logging.getLogger(__name__)

_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"

_PROPERTY_MAP = {
    "MolecularWeight": "drug_molecular_weight",
    "TPSA": "tpsa",
    "HBondDonorCount": "hbd",
    "HBondAcceptorCount": "hba",
    "XLogP": "drug_logp",
    "HeavyAtomCount": "drug_nha",
}

_PUBCHEM_PROPS = ",".join(_PROPERTY_MAP.keys())

_CACHE_FILE = Path("output/pubchem_cache.json")
_CACHE: dict[str, dict] = {}
_CACHE_DIRTY = False

_SPLIT_RE = re.compile(r"\s*[;/]\s*|\s+and\s+", re.IGNORECASE)
_PAREN_RE = re.compile(r"\s*\(.*?\)\s*")

MAX_CONCURRENCY = 3
RETRY_ATTEMPTS = 3
RETRY_DELAY = 1.5


def _load_cache() -> dict[str, dict]:
    """Load persistent cache from disk."""
    if _CACHE_FILE.exists():
        try:
            return json.loads(_CACHE_FILE.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            logger.warning("PubChem cache file corrupt, starting fresh")
    return {}


def _save_cache() -> None:
    """Write current cache to disk."""
    global _CACHE_DIRTY
    _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CACHE_FILE.write_text(json.dumps(_CACHE, ensure_ascii=False, indent=2), "utf-8")
    _CACHE_DIRTY = False


def _ensure_cache_loaded() -> None:
    """Lazy-load cache on first access."""
    global _CACHE
    if not _CACHE and _CACHE_FILE.exists():
        _CACHE = _load_cache()


def _normalize_drug_name(name: str) -> str:
    """Normalize drug name for cache key to improve hit rate.

    Lowercases, strips parenthetical suffixes, removes common bio-prefixes
    like 'recombinant' and suffixes like 'protein'/'peptide'.
    """
    key = name.lower().strip()
    key = key.split("(")[0].strip()
    for prefix in ("recombinant ", "rh-", "rh "):
        if key.startswith(prefix):
            key = key[len(prefix):]
    for suffix in (" protein", " peptide", " hydrochloride", " hcl"):
        if key.endswith(suffix):
            key = key[: -len(suffix)]
    key = re.sub(r"\s+", " ", key).strip()
    return key


def _get_cached(drug_name: str) -> dict | None:
    _ensure_cache_loaded()
    key = _normalize_drug_name(drug_name)
    if not key:
        return None
    return _CACHE.get(key)


def _set_cached(drug_name: str, data: dict) -> None:
    global _CACHE_DIRTY
    _ensure_cache_loaded()
    key = _normalize_drug_name(drug_name)
    if key:
        _CACHE[key] = data
        _CACHE_DIRTY = True


def cache_stats() -> dict:
    """Return cache statistics for the management API."""
    _ensure_cache_loaded()
    size_kb = _CACHE_FILE.stat().st_size / 1024 if _CACHE_FILE.exists() else 0
    return {"total_cached": len(_CACHE), "cache_file_size_kb": round(size_kb, 1)}


def clear_cache() -> int:
    """Clear all cached entries. Returns the number of entries removed."""
    global _CACHE, _CACHE_DIRTY
    count = len(_CACHE)
    _CACHE = {}
    _CACHE_DIRTY = False
    if _CACHE_FILE.exists():
        _CACHE_FILE.unlink()
    return count


def _split_drug_name(raw_name: str) -> list[str]:
    """Split compound drug names and generate lookup variants.

    e.g. "epigallocatechin gallate; triamcinolone acetonide" -> two names
    e.g. "doxorubicin hydrochloride" -> try as-is first, then "doxorubicin"
    e.g. "FITC-BSA" -> try "BSA" as fallback
    """
    parts = _SPLIT_RE.split(raw_name.strip())
    names: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        names.append(part)
        without_paren = _PAREN_RE.sub(" ", part).strip()
        if without_paren and without_paren != part:
            names.append(without_paren)
    return names


async def _resolve_cid_once(
    session: aiohttp.ClientSession, drug_name: str
) -> int | None:
    url = f"{_BASE}/compound/name/{quote(drug_name, safe='')}/cids/JSON"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status == 404:
                return None
            if resp.status != 200:
                logger.debug("PubChem CID non-200 for '%s': %d", drug_name, resp.status)
                return None
            data = await resp.json()
            cids = data.get("IdentifierList", {}).get("CID", [])
            return cids[0] if cids else None
    except Exception as e:
        logger.debug("PubChem CID lookup failed for '%s': %s", drug_name, e)
        return None


async def _resolve_cid(
    session: aiohttp.ClientSession, drug_name: str
) -> int | None:
    """Resolve a drug name to a PubChem CID with retries."""
    for attempt in range(RETRY_ATTEMPTS):
        cid = await _resolve_cid_once(session, drug_name)
        if cid is not None:
            return cid
        if attempt < RETRY_ATTEMPTS - 1:
            await asyncio.sleep(RETRY_DELAY * (attempt + 1))
    return None


async def _fetch_properties(session: aiohttp.ClientSession, cid: int) -> dict:
    """Fetch physicochemical properties for a given CID with retries."""
    url = f"{_BASE}/compound/cid/{cid}/property/{_PUBCHEM_PROPS}/JSON"
    for attempt in range(RETRY_ATTEMPTS):
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    props_list = data.get("PropertyTable", {}).get("Properties", [])
                    return props_list[0] if props_list else {}
                if resp.status == 404:
                    return {}
                logger.debug("PubChem property non-200 for CID %d: %d", cid, resp.status)
        except Exception as e:
            logger.debug("PubChem property fetch failed for CID %d: %s", cid, e)
        if attempt < RETRY_ATTEMPTS - 1:
            await asyncio.sleep(RETRY_DELAY * (attempt + 1))
    return {}


def _map_properties(raw_props: dict) -> dict[str, str | float | None]:
    result: dict[str, str | float | None] = {}
    for pubchem_key, our_field in _PROPERTY_MAP.items():
        val = raw_props.get(pubchem_key)
        if val is not None:
            result[our_field] = val
    return result


async def lookup_drug(
    drug_name: str,
    session: aiohttp.ClientSession | None = None,
) -> dict[str, str | float | None]:
    """Look up drug properties from PubChem by name.

    Handles compound names (split by ;/and) and parenthetical variants.
    Uses retries and rate limiting.
    Returns a dict with our field names as keys, or empty dict on failure.
    """
    if not drug_name or not drug_name.strip():
        return {}

    name = drug_name.strip()
    cached = _get_cached(name)
    if cached is not None:
        return cached

    owns_session = session is None
    if owns_session:
        session = aiohttp.ClientSession()

    try:
        variants = _split_drug_name(name)
        for variant in variants:
            cid = await _resolve_cid(session, variant)
            if cid:
                raw_props = await _fetch_properties(session, cid)
                if raw_props:
                    result = _map_properties(raw_props)
                    if result:
                        logger.info(
                            "PubChem resolved '%s' (via variant '%s', CID=%d) → %d properties",
                            name, variant, cid, len(result),
                        )
                        _set_cached(name, result)
                        return result

        logger.debug("No PubChem data found for '%s' (tried %d variants)", name, len(variants))
        _set_cached(name, {})
        return {}
    finally:
        if owns_session:
            await session.close()


async def batch_lookup(
    drug_names: set[str],
    on_progress: Callable[[int, int, str], None] | None = None,
) -> tuple[dict[str, dict], dict]:
    """Look up multiple drugs with controlled concurrency.

    Uses a semaphore to limit to MAX_CONCURRENCY parallel requests,
    preventing PubChem rate limiting.

    *on_progress(done, total, current_name)* is called after each lookup.

    Returns ``(results_dict, stats_dict)`` where *stats_dict* contains
    ``cache_hit``, ``queried``, and ``total`` counts.
    """
    if not drug_names:
        return {}, {"cache_hit": 0, "queried": 0, "total": 0}

    cache: dict[str, dict] = {}
    to_fetch: list[str] = []

    for name in drug_names:
        cached = _get_cached(name)
        if cached is not None:
            cache[name] = cached
        else:
            to_fetch.append(name)

    cache_hit = len(cache)
    total = len(to_fetch)
    done = 0

    if to_fetch:
        sem = asyncio.Semaphore(MAX_CONCURRENCY)

        async with aiohttp.ClientSession() as session:
            async def _do(n: str) -> None:
                nonlocal done
                async with sem:
                    cache[n] = await lookup_drug(n, session=session)
                    done += 1
                    if on_progress:
                        on_progress(done, total, n)
                    await asyncio.sleep(0.3)

            await asyncio.gather(*[_do(n) for n in to_fetch])

        if _CACHE_DIRTY:
            _save_cache()

    stats = {"cache_hit": cache_hit, "queried": total, "total": len(drug_names)}
    logger.info("PubChem batch: %d cached, %d queried, %d total", cache_hit, total, len(drug_names))
    return cache, stats


def enrich_row(row: dict, pubchem_data: dict, force: bool = False) -> int:
    """Fill drug properties in a row from PubChem data.

    When *force* is False (default), only fills fields that are currently
    None or empty.  When *force* is True, overwrites existing LLM-extracted
    values with authoritative PubChem data.
    Returns the number of fields filled/overwritten.
    """
    filled = 0
    confidence = row.get("_confidence", {}) or {}

    for field, value in pubchem_data.items():
        if not force:
            current = row.get(field)
            if current is not None and str(current).strip():
                continue
        row[field] = value
        filled += 1
        if isinstance(confidence, dict):
            confidence[field] = "pubchem"

    if filled and isinstance(confidence, dict):
        row["_confidence"] = confidence

    return filled
