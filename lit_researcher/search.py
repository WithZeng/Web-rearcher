"""Search papers across multiple databases with merge + deduplication."""

from __future__ import annotations

import functools
import time
import logging
import concurrent.futures
from collections import defaultdict
from collections.abc import Callable
from typing import Any

import requests
import findpapers

from . import config

logger = logging.getLogger(__name__)

CROSSREF_API = "https://api.crossref.org/works"
_MAX_RETRIES = 3

_SEARCHER_REGISTRY: dict[str, tuple] = {}


def _register(name: str):
    def decorator(fn):
        _SEARCHER_REGISTRY[name] = fn
        return fn
    return decorator


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_with_retry(url: str, params: dict) -> requests.Response:
    for attempt in range(_MAX_RETRIES):
        resp = requests.get(url, params=params, timeout=30)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = 2 ** attempt
            logger.warning("Rate limited (HTTP %d), retrying in %ds ...", resp.status_code, wait)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp
    resp.raise_for_status()
    return resp


def _pick_best(a: str | None, b: str | None) -> str | None:
    """Return the longer non-empty value, preferring non-None."""
    if not a:
        return b
    if not b:
        return a
    return a if len(a) >= len(b) else b


def _merge_papers(group: list[dict]) -> dict:
    """Merge a group of paper dicts sharing the same DOI/title key.

    For each field, pick the longest non-empty string value (or any non-None
    value for non-string fields). This preserves pdf_url from one source and
    abstract from another.
    """
    merged: dict = {}
    for paper in group:
        for key, value in paper.items():
            existing = merged.get(key)
            if isinstance(value, str) or isinstance(existing, str):
                merged[key] = _pick_best(existing, value)
            elif existing is None:
                merged[key] = value
    return merged


def _pick_best_paper(group: list[dict]) -> dict:
    """From a group of duplicates, keep the most complete record.

    Falls back to field-level merge only when the top two have equal completeness.
    """
    def _completeness(p: dict) -> int:
        return sum(1 for v in p.values() if v is not None and str(v).strip())

    group.sort(key=_completeness, reverse=True)
    best = group[0]
    if len(group) > 1 and _completeness(group[1]) == _completeness(best):
        best = _merge_papers([best, group[1]])
    return best


def _merge_and_deduplicate(papers: list[dict]) -> list[dict]:
    """Group papers by DOI (or title prefix if no DOI), keep best per group."""
    doi_groups: dict[str, list[dict]] = defaultdict(list)
    title_groups: dict[str, list[dict]] = defaultdict(list)
    no_key: list[dict] = []

    for p in papers:
        doi = (p.get("doi") or "").strip().lower()
        title_key = (p.get("title") or "").strip().lower()[:80]
        if doi:
            doi_groups[doi].append(p)
        elif title_key:
            title_groups[title_key].append(p)
        else:
            no_key.append(p)

    seen_titles: set[str] = set()
    unique: list[dict] = []

    for doi, group in doi_groups.items():
        best = _pick_best_paper(group)
        unique.append(best)
        title_key = (best.get("title") or "").strip().lower()[:80]
        if title_key:
            seen_titles.add(title_key)

    for title_key, group in title_groups.items():
        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        unique.append(_pick_best_paper(group))

    unique.extend(no_key)
    return unique


def _normalize_doi_key(raw: str) -> str:
    doi = (raw or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
    return doi.strip().strip("/")


def _normalize_title_key(raw: str) -> str:
    return (raw or "").strip().lower()[:80]


def _filter_seen_candidates(
    papers: list[dict],
    seen_doi_keys: set[str],
    seen_title_keys: set[str],
) -> list[dict]:
    fresh: list[dict] = []
    for paper in papers:
        doi_key = _normalize_doi_key(str(paper.get("doi") or ""))
        title_key = _normalize_title_key(str(paper.get("title") or ""))
        if doi_key and doi_key in seen_doi_keys:
            continue
        if title_key and title_key in seen_title_keys:
            continue
        fresh.append(paper)
    return fresh


def _mark_seen_candidates(
    papers: list[dict],
    seen_doi_keys: set[str],
    seen_title_keys: set[str],
) -> None:
    for paper in papers:
        doi_key = _normalize_doi_key(str(paper.get("doi") or ""))
        title_key = _normalize_title_key(str(paper.get("title") or ""))
        if doi_key:
            seen_doi_keys.add(doi_key)
        if title_key:
            seen_title_keys.add(title_key)


# ── OpenAlex ─────────────────────────────────────────────────────────────────


def _openalex_abstract(item: dict) -> str:
    """Extract abstract from OpenAlex, handling inverted index format."""
    raw = item.get("abstract_inverted_index")
    if isinstance(raw, dict) and raw:
        word_positions: list[tuple[int, str]] = []
        for word, positions in raw.items():
            for pos in positions:
                word_positions.append((pos, word))
        word_positions.sort()
        return " ".join(w for _, w in word_positions)
    plain = item.get("abstract")
    if isinstance(plain, str) and plain:
        return plain
    return ""


@_register("OpenAlex")
def _search_openalex(query: str, limit: int) -> list[dict]:
    results_raw, _state = _search_openalex_batch(query, limit, {})
    return results_raw[:limit]


def _search_openalex_batch(
    query: str,
    batch_size: int,
    cursor_state: dict[str, Any] | None = None,
) -> tuple[list[dict], dict[str, Any]]:
    cursor_state = dict(cursor_state or {})
    if cursor_state.get("exhausted"):
        return [], cursor_state

    params = {
        "search": query,
        "per-page": min(max(batch_size, 1), 200),
        "cursor": cursor_state.get("cursor") or "*",
        "select": "id,display_name,doi,abstract_inverted_index,open_access,ids",
    }
    resp = _get_with_retry("https://api.openalex.org/works", params)
    payload = resp.json()
    results_raw = payload.get("results", []) or []
    next_cursor = (payload.get("meta") or {}).get("next_cursor")
    results = []
    for item in results_raw:
        doi = item.get("doi", "") or ""
        if doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/"):]

        oa = item.get("open_access", {}) or {}
        pdf_url = oa.get("oa_url") or None

        pmcid = None
        ids = item.get("ids", {}) or {}
        pmcid_raw = ids.get("pmcid") or ""
        if pmcid_raw:
            pmcid = pmcid_raw.replace("https://www.ncbi.nlm.nih.gov/pmc/articles/", "").rstrip("/")

        abstract = _openalex_abstract(item)

        results.append({
            "paper_id": item.get("id", "") or doi,
            "title": item.get("display_name", "") or item.get("title", "") or "",
            "doi": doi,
            "abstract": abstract,
            "pdf_url": pdf_url,
            "web_url": item.get("id", "") or (f"https://doi.org/{doi}" if doi else ""),
            "pmcid": pmcid,
        })
    next_state = {
        **cursor_state,
        "cursor": next_cursor,
        "exhausted": not results_raw or not next_cursor,
    }
    return results, next_state


# ── PubMed (via findpapers) ──────────────────────────────────────────────────


@_register("PubMed")
def _search_pubmed(query: str, limit: int) -> list[dict]:
    engine = _build_findpapers_engine()
    result = engine.search(query, databases=["pubmed"], max_papers_per_database=limit, show_progress=False)
    return _normalize_findpapers_results(list(result.papers)[:limit])


# ── Semantic Scholar (via findpapers) ────────────────────────────────────────


@_register("Semantic Scholar")
def _search_semantic_scholar(query: str, limit: int) -> list[dict]:
    engine = _build_findpapers_engine()
    result = engine.search(query, databases=["semantic_scholar"], max_papers_per_database=limit, show_progress=False)
    return _normalize_findpapers_results(list(result.papers)[:limit])


# ── arXiv (via findpapers) ───────────────────────────────────────────────────


@_register("arXiv")
def _search_arxiv(query: str, limit: int) -> list[dict]:
    engine = _build_findpapers_engine()
    result = engine.search(query, databases=["arxiv"], max_papers_per_database=limit, show_progress=False)
    return _normalize_findpapers_results(list(result.papers)[:limit])


# ── IEEE (via findpapers, requires key) ──────────────────────────────────────


@_register("IEEE")
def _search_ieee(query: str, limit: int) -> list[dict]:
    if not config.IEEE_API_KEY:
        logger.warning("IEEE search skipped: IEEE_API_KEY not set")
        return []
    engine = _build_findpapers_engine()
    result = engine.search(query, databases=["ieee"], max_papers_per_database=limit, show_progress=False)
    return _normalize_findpapers_results(list(result.papers)[:limit])


# ── Scopus (via findpapers, requires key) ────────────────────────────────────


@_register("Scopus")
def _search_scopus(query: str, limit: int) -> list[dict]:
    if not config.SCOPUS_API_KEY:
        logger.warning("Scopus search skipped: SCOPUS_API_KEY not set")
        return []
    engine = _build_findpapers_engine()
    result = engine.search(query, databases=["scopus"], max_papers_per_database=limit, show_progress=False)
    return _normalize_findpapers_results(list(result.papers)[:limit])


# ── Google Scholar ───────────────────────────────────────────────────────────


@_register("Google Scholar")
def _search_google_scholar(query: str, limit: int) -> list[dict]:
    from scholarly import scholarly as scholar_api

    search_iter = scholar_api.search_pubs(query)
    results = []
    for _ in range(min(limit, 20)):
        pub = next(search_iter, None)
        if not pub:
            break
        bib = pub.get("bib", {})
        doi = bib.get("doi", "") or ""
        title = bib.get("title", "") or ""
        url = pub.get("pub_url") or pub.get("eprint_url") or ""

        results.append({
            "paper_id": doi or title[:60],
            "title": title,
            "doi": doi,
            "abstract": bib.get("abstract", "") or "",
            "pdf_url": pub.get("eprint_url") or None,
            "web_url": url,
        })
    return results


# ── CrossRef ─────────────────────────────────────────────────────────────────


@_register("CrossRef")
def _search_crossref(query: str, limit: int) -> list[dict]:
    results, _state = _search_crossref_batch(query, limit, {})
    return results[:limit]


def _search_crossref_batch(
    query: str,
    batch_size: int,
    cursor_state: dict[str, Any] | None = None,
) -> tuple[list[dict], dict[str, Any]]:
    import re as _re

    cursor_state = dict(cursor_state or {})
    if cursor_state.get("exhausted"):
        return [], cursor_state

    rows = min(max(batch_size, 1), 1000)
    params = {
        "query.bibliographic": query,
        "rows": rows,
        "offset": int(cursor_state.get("offset") or 0),
        "select": "DOI,title,abstract,link",
    }
    resp = _get_with_retry(CROSSREF_API, params)
    items = resp.json().get("message", {}).get("items", [])

    results = []
    for item in items:
        title = ""
        if item.get("title"):
            title = item["title"][0]
        doi = item.get("DOI", "")

        pdf_url = None
        for link in item.get("link", []):
            if link.get("content-type") == "application/pdf":
                pdf_url = link.get("URL")
                break

        web_url = f"https://doi.org/{doi}" if doi else ""

        abstract_raw = item.get("abstract", "") or ""
        abstract = _re.sub(r"<[^>]+>", "", abstract_raw).strip() if abstract_raw else ""

        results.append({
            "paper_id": doi,
            "title": title,
            "doi": doi,
            "abstract": abstract,
            "pdf_url": pdf_url,
            "web_url": web_url,
        })
    next_state = {
        **cursor_state,
        "offset": int(cursor_state.get("offset") or 0) + len(items),
        "exhausted": not items or len(items) < rows,
    }
    return results, next_state


# ── findpapers shared helpers ────────────────────────────────────────────────


@functools.lru_cache(maxsize=1)
def _build_findpapers_engine_cached(ieee_key: str, scopus_key: str) -> findpapers.Engine:
    kwargs: dict = {}
    if ieee_key:
        kwargs["ieee_api_key"] = ieee_key
    if scopus_key:
        kwargs["scopus_api_key"] = scopus_key
    return findpapers.Engine(**kwargs)


def _build_findpapers_engine() -> findpapers.Engine:
    return _build_findpapers_engine_cached(
        config.IEEE_API_KEY or "",
        config.SCOPUS_API_KEY or "",
    )


def _normalize_findpapers_results(papers) -> list[dict]:
    results = []
    for paper in papers:
        doi = paper.doi or ""
        title = paper.title or ""
        abstract = paper.abstract or ""
        pdf_url = paper.pdf_url or None
        web_url = paper.url or ""
        if not web_url and doi:
            web_url = f"https://doi.org/{doi}"

        results.append({
            "paper_id": doi or title[:60],
            "title": title,
            "doi": doi,
            "abstract": abstract,
            "pdf_url": pdf_url,
            "web_url": web_url,
        })
    return results


# ── Query adaptation ─────────────────────────────────────────────────────────

import re as _re_mod

_BOOLEAN_OPS = {"AND", "OR", "NOT"}

_FINDPAPERS_DBS = {"PubMed", "Semantic Scholar", "arXiv", "IEEE", "Scopus"}


def _has_findpapers_brackets(query: str) -> bool:
    """Check if query already uses findpapers [term] syntax."""
    return bool(_re_mod.search(r'\[.+?\]', query))


def _is_boolean_query(query: str) -> bool:
    """Check if query already contains Boolean operators."""
    tokens = set(query.split())
    return bool(tokens & _BOOLEAN_OPS)


def _to_findpapers_query(query: str) -> str:
    """Convert a natural language query to findpapers bracket syntax.

    findpapers requires terms wrapped in [], e.g.:
      [GelMA] AND [microsphere] AND [drug release]

    Groups multi-word phrases that commonly appear together.
    """
    if _has_findpapers_brackets(query):
        return query

    if _is_boolean_query(query):
        return _re_mod.sub(
            r'(?<!\[)\b([A-Za-z][A-Za-z0-9 -]*?)(?=\s+(?:AND|OR|NOT)\b|\s*$)',
            lambda m: f'[{m.group(1).strip()}]' if not m.group(1).strip().startswith('[') else m.group(0),
            query,
        )

    stop_words = {
        "the", "a", "an", "of", "in", "on", "for", "with", "and", "or",
        "to", "from", "by", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "can", "shall",
        "about", "how", "what", "which", "that", "this", "these", "those",
        "using", "based", "via", "through",
    }

    quoted = _re_mod.findall(r'"([^"]+?)"', query)
    remaining = _re_mod.sub(r'"[^"]+?"', '', query)

    words = [w for w in remaining.split() if w.lower() not in stop_words and len(w) > 1]

    terms: list[str] = []
    for phrase in quoted:
        terms.append(f"[{phrase}]")

    i = 0
    while i < len(words):
        if i + 1 < len(words) and words[i][0].isupper() and words[i + 1][0].isupper():
            terms.append(f"[{words[i]} {words[i + 1]}]")
            i += 2
        else:
            terms.append(f"[{words[i]}]")
            i += 1

    if not terms:
        return f"[{query.strip()}]"

    if len(terms) == 1:
        return terms[0]

    return " AND ".join(terms)


def _adapt_query(query: str, db_name: str) -> str:
    """Adapt query syntax for a specific database."""
    if db_name in _FINDPAPERS_DBS:
        return _to_findpapers_query(query)
    return query


# ── Main entry point ─────────────────────────────────────────────────────────


def _search_single_db(db_name: str, query: str, limit: int) -> list[dict]:
    """Run a single database search, returning results or empty on failure."""
    searcher = _SEARCHER_REGISTRY.get(db_name)
    if not searcher:
        logger.warning("Unknown database: %s", db_name)
        return []
    adapted_query = _adapt_query(query, db_name)
    if adapted_query != query:
        logger.info("%s: adapted query '%s' -> '%s'", db_name, query[:60], adapted_query[:60])
    try:
        results = searcher(adapted_query, limit)
        if results:
            logger.info("%s returned %d papers", db_name, len(results))
            return results
    except Exception as e:
        logger.warning("%s failed: %s", db_name, e)
    return []


def _fetch_rolling_db_batch(
    db_name: str,
    query: str,
    batch_size: int,
    cursor_state: dict[str, Any] | None,
    round_number: int,
) -> tuple[list[dict], dict[str, Any], bool]:
    cursor_state = dict(cursor_state or {})
    if db_name == "OpenAlex":
        results, next_state = _search_openalex_batch(query, batch_size, cursor_state)
        return results, next_state, bool(next_state.get("exhausted"))
    if db_name == "CrossRef":
        results, next_state = _search_crossref_batch(query, batch_size, cursor_state)
        return results, next_state, bool(next_state.get("exhausted"))

    if round_number > 1 or cursor_state.get("exhausted"):
        next_state = {**cursor_state, "exhausted": True, "limited": True}
        return [], next_state, True

    results = _search_single_db(db_name, query, batch_size)
    next_state = {**cursor_state, "exhausted": True, "limited": True}
    return results, next_state, True


def search_papers_with_stats(
    query: str,
    limit: int | None = None,
    databases: list[str] | None = None,
    on_db_done: Callable[[str, int], None] | None = None,
) -> tuple[list[dict], dict]:
    """Search papers across databases and return both results and aggregation stats."""
    limit = limit or config.MAX_RESULTS
    databases = databases or config.DEFAULT_DATABASES

    n_dbs = max(len(databases), 1)
    per_db_limit = max(int(limit / n_dbs * 1.5) + 1, limit) if n_dbs <= 2 else max(int(limit / n_dbs * 1.5) + 1, 10)

    all_results: list[dict] = []
    db_counts: dict[str, int] = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(databases)) as executor:
        future_to_db = {
            executor.submit(_search_single_db, db_name, query, per_db_limit): db_name
            for db_name in databases
        }
        for future in concurrent.futures.as_completed(future_to_db):
            db_name = future_to_db[future]
            try:
                results = future.result(timeout=_SEARCH_TIMEOUT_PER_DB)
                count = len(results) if results else 0
                db_counts[db_name] = count
                if results:
                    all_results.extend(results)
                if on_db_done:
                    on_db_done(db_name, count)
            except concurrent.futures.TimeoutError:
                db_counts[db_name] = 0
                logger.warning("%s search timed out after %ds, skipping", db_name, _SEARCH_TIMEOUT_PER_DB)
            except Exception as e:
                db_counts[db_name] = 0
                logger.warning("%s search failed: %s", db_name, e)

    deduped = _merge_and_deduplicate(all_results)
    limited = deduped[:limit]
    stats = {
        "requested_limit": limit,
        "per_db_limit": per_db_limit,
        "db_counts": db_counts,
        "raw_count": len(all_results),
        "deduped_count": len(deduped),
        "returned_count": len(limited),
        "database_count": len(databases),
    }
    logger.info(
        "Search stats: requested_limit=%d per_db_limit=%d raw=%d deduped=%d returned=%d db_counts=%s",
        limit,
        per_db_limit,
        stats["raw_count"],
        stats["deduped_count"],
        stats["returned_count"],
        db_counts,
    )
    return limited, stats


def search_papers_rolling_with_stats(
    query: str,
    max_unique_candidates: int,
    databases: list[str] | None = None,
    *,
    round_number: int,
    seen_doi_keys: set[str] | None = None,
    seen_title_keys: set[str] | None = None,
    per_db_cursor_state: dict[str, Any] | None = None,
    current_unique_count: int = 0,
    desired_new_candidates: int | None = None,
    on_db_done: Callable[[str, int], None] | None = None,
) -> tuple[list[dict], dict, dict[str, Any], list[str]]:
    databases = databases or config.DEFAULT_DATABASES
    seen_doi_keys = set(seen_doi_keys or set())
    seen_title_keys = set(seen_title_keys or set())
    per_db_cursor_state = dict(per_db_cursor_state or {})

    remaining_capacity = max(max_unique_candidates - current_unique_count, 0)
    if remaining_capacity <= 0:
        exhausted_sources = sorted(databases)
        return [], {
            "round_number": round_number,
            "db_counts": {db: 0 for db in databases},
            "raw_count": 0,
            "deduped_count": 0,
            "returned_count": 0,
            "remaining_capacity": 0,
        }, per_db_cursor_state, exhausted_sources

    desired_new_candidates = desired_new_candidates or min(remaining_capacity, 200)
    desired_new_candidates = max(1, min(desired_new_candidates, remaining_capacity))
    n_dbs = max(len(databases), 1)
    per_db_limit = max(min((desired_new_candidates // n_dbs) + 1, remaining_capacity), 10)

    all_results: list[dict] = []
    db_counts: dict[str, int] = {}
    exhausted_sources: list[str] = []

    for db_name in databases:
        db_state = per_db_cursor_state.get(db_name) or {}
        results, next_state, exhausted = _fetch_rolling_db_batch(
            db_name,
            query,
            per_db_limit,
            db_state,
            round_number,
        )
        db_counts[db_name] = len(results)
        per_db_cursor_state[db_name] = next_state
        if exhausted:
            exhausted_sources.append(db_name)
        if results:
            all_results.extend(results)
        if on_db_done:
            on_db_done(db_name, len(results))

    deduped = _merge_and_deduplicate(all_results)
    fresh = _filter_seen_candidates(deduped, seen_doi_keys, seen_title_keys)
    limited = fresh[:remaining_capacity]
    stats = {
        "round_number": round_number,
        "requested_limit": max_unique_candidates,
        "per_db_limit": per_db_limit,
        "db_counts": db_counts,
        "raw_count": len(all_results),
        "deduped_count": len(limited),
        "returned_count": len(limited),
        "database_count": len(databases),
        "remaining_capacity": remaining_capacity,
    }
    logger.info(
        "Rolling search stats: round=%d raw=%d new_unique=%d remaining_capacity=%d db_counts=%s exhausted=%s",
        round_number,
        len(all_results),
        len(limited),
        remaining_capacity - len(limited),
        db_counts,
        exhausted_sources,
    )
    return limited, stats, per_db_cursor_state, exhausted_sources


_SEARCH_TIMEOUT_PER_DB = 120


def search_papers(
    query: str,
    limit: int | None = None,
    databases: list[str] | None = None,
    on_db_done: Callable[[str, int], None] | None = None,
) -> list[dict]:
    """Search papers across selected databases, merge and deduplicate results.

    *databases* is a list of names from config.ALL_DATABASES.
    If None, uses config.DEFAULT_DATABASES.
    *on_db_done* is called after each database finishes with (db_name, result_count).

    Each database gets a per-DB quota (limit / n_dbs * 1.5, rounded up)
    to avoid over-fetching when many DBs are selected. A per-DB timeout
    of 120s prevents slow sources from blocking the pipeline.
    """
    results, _stats = search_papers_with_stats(
        query=query,
        limit=limit,
        databases=databases,
        on_db_done=on_db_done,
    )
    return results
