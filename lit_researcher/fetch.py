"""Async concurrent fetch of PDF / webpage text with caching.

Fetch chain per paper (stops at first success):
  1. pdf_url (from search)
  2. Unpaywall PDF lookup (by DOI)
  3. Semantic Scholar open-access PDF (by DOI)
  4. NCBI ID Converter → PMC XML full text (by DOI/PMCID)
  5. CORE.ac.uk full text (by DOI)
  6. web_url (DOI landing page) — with quality filter
  7. CrossRef full abstract (by DOI)
  8. Semantic Scholar abstract (by DOI)
  9. search abstract (last resort)
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import random
import re
import ssl as _ssl_mod
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import aiohttp
from aiolimiter import AsyncLimiter
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from . import config

logger = logging.getLogger(__name__)

try:
    import brotlicffi  # noqa: F401
    _ACCEPT_ENCODING = "gzip, deflate, br"
except ImportError:
    _ACCEPT_ENCODING = "gzip, deflate"

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
]


def _random_ua() -> str:
    return random.choice(_USER_AGENTS)


def _base_headers() -> dict[str, str]:
    return {
        "User-Agent": _random_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": _ACCEPT_ENCODING,
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-User": "?1",
        "DNT": "1",
        "Cache-Control": "max-age=0",
    }


def _pdf_accept_headers() -> dict[str, str]:
    h = _base_headers()
    h["Accept"] = "application/pdf,*/*;q=0.8"
    return h

_PUBLISHER_REFERERS = {
    "elsevier.com": "https://www.sciencedirect.com/",
    "sciencedirect.com": "https://www.sciencedirect.com/",
    "springer.com": "https://link.springer.com/",
    "springerlink.com": "https://link.springer.com/",
    "nature.com": "https://www.nature.com/",
    "wiley.com": "https://onlinelibrary.wiley.com/",
    "mdpi.com": "https://www.mdpi.com/",
    "acs.org": "https://pubs.acs.org/",
    "rsc.org": "https://pubs.rsc.org/",
    "cell.com": "https://www.cell.com/",
    "tandfonline.com": "https://www.tandfonline.com/",
    "sagepub.com": "https://journals.sagepub.com/",
    "iop.org": "https://iopscience.iop.org/",
    "frontiersin.org": "https://www.frontiersin.org/",
}


def _get_referer(url: str) -> str:
    """Pick a plausible Referer for the given URL based on publisher domain."""
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return "https://scholar.google.com/"
    for domain, referer in _PUBLISHER_REFERERS.items():
        if domain in host:
            return referer
    return "https://scholar.google.com/"


def _headers_for(url: str, pdf: bool = False) -> dict[str, str]:
    """Build request headers with a fresh random UA and appropriate Referer."""
    base = _pdf_accept_headers() if pdf else _base_headers()
    base["Referer"] = _get_referer(url)
    return base


def _get_limiter() -> AsyncLimiter:
    """Return a per-event-loop rate limiter (avoids cross-loop reuse warnings)."""
    loop = asyncio.get_running_loop()
    limiter = getattr(loop, "_fetch_limiter", None)
    if limiter is None:
        limiter = AsyncLimiter(3, 1)
        loop._fetch_limiter = limiter  # type: ignore[attr-defined]
    return limiter

_MIN_USEFUL_TEXT = 200


# ── PDF helpers ──────────────────────────────────────────────────────────────


def _pdf_cache_path(url: str) -> Path:
    h = hashlib.md5(url.encode()).hexdigest()[:16]
    return config.PDF_CACHE_DIR / f"{h}.pdf"


def _is_valid_pdf(data: bytes) -> bool:
    return data[:5].startswith(b"%PDF")


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    # Tier 0: GROBID (structured academic parser) — only when configured
    if config.GROBID_URL:
        try:
            from .grobid_client import parse_pdf_grobid
            text = parse_pdf_grobid(pdf_bytes)
            if len(text.strip()) > _MIN_USEFUL_TEXT:
                return text[:config.MAX_TEXT_LEN]
        except Exception:
            pass

    # Tier 1: pypdf (fast, handles most PDFs)
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n".join(pages)
        if len(text.strip()) > _MIN_USEFUL_TEXT:
            return text[:config.MAX_TEXT_LEN]
    except Exception:
        pass

    # Tier 2: PyMuPDF (better table/layout handling, faster than pdfplumber)
    try:
        import pymupdf
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        pages = [page.get_text() for page in doc]
        doc.close()
        text = "\n".join(pages)
        if len(text.strip()) > _MIN_USEFUL_TEXT:
            return text[:config.MAX_TEXT_LEN]
    except Exception:
        pass

    return ""


def _extract_webpage_text(html: str) -> str:
    from readability import Document
    from bs4 import BeautifulSoup
    doc = Document(html)
    soup = BeautifulSoup(doc.summary(), "html.parser")
    return soup.get_text(separator="\n", strip=True)[:config.MAX_TEXT_LEN]


# ── Network helpers ──────────────────────────────────────────────────────────


class _ForbiddenError(aiohttp.ClientResponseError):
    """Raised on HTTP 403 so we can retry with different headers."""


_NOSSL = _ssl_mod.create_default_context()
_NOSSL.check_hostname = False
_NOSSL.verify_mode = _ssl_mod.CERT_NONE


@retry(
    stop=stop_after_attempt(2),
    wait=wait_exponential(multiplier=2, min=3, max=20),
    retry=retry_if_exception_type((aiohttp.ClientError, asyncio.TimeoutError)),
    reraise=True,
)
async def _download(
    session: aiohttp.ClientSession,
    url: str,
    timeout: int = 60,
    pdf: bool = False,
) -> bytes:
    headers = _headers_for(url, pdf=pdf)
    ct = aiohttp.ClientTimeout(total=timeout)
    async with _get_limiter():
        await asyncio.sleep(random.uniform(0.3, 1.5))
        try:
            async with session.get(url, headers=headers, timeout=ct, allow_redirects=True) as resp:
                if resp.status == 403:
                    raise _ForbiddenError(
                        request_info=resp.request_info,
                        history=resp.history,
                        status=403,
                        message="Forbidden",
                        headers=resp.headers,
                    )
                resp.raise_for_status()
                return await resp.read()
        except _ssl_mod.SSLCertVerificationError:
            logger.debug("SSL verification failed for %s, retrying without verification", url)
            async with session.get(url, headers=headers, timeout=ct, allow_redirects=True, ssl=_NOSSL) as resp:
                resp.raise_for_status()
                return await resp.read()


async def _download_json(session: aiohttp.ClientSession, url: str, timeout: int = 20) -> dict | None:
    headers = _base_headers()
    headers["Accept"] = "application/json,*/*;q=0.8"
    try:
        async with _get_limiter():
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                if resp.status == 200:
                    return await resp.json(content_type=None)
    except Exception:
        pass
    return None


# ── Publisher-specific helpers ────────────────────────────────────────────────

_PUBLISHER_PDF_PATTERNS: list[tuple[str, str]] = [
    ("mdpi.com", "/pdf"),
    ("frontiersin.org", "/pdf"),
]


def _doi_to_article_url(doi: str) -> str:
    """Resolve a DOI to its landing page URL."""
    return f"https://doi.org/{doi}"


async def _warm_session(session: aiohttp.ClientSession, url: str) -> None:
    """Visit the article landing page first to pick up session cookies."""
    try:
        headers = _base_headers()
        headers["Referer"] = "https://scholar.google.com/"
        ct = aiohttp.ClientTimeout(total=20)
        async with _get_limiter():
            await asyncio.sleep(random.uniform(0.5, 1.5))
            async with session.get(url, headers=headers, timeout=ct, allow_redirects=True) as resp:
                await resp.read()
    except Exception:
        pass


# ── Fetch strategies ─────────────────────────────────────────────────────────


async def _fetch_pdf(session: aiohttp.ClientSession, url: str) -> str:
    cache = _pdf_cache_path(url)
    if cache.exists():
        pdf_bytes = cache.read_bytes()
        if not _is_valid_pdf(pdf_bytes):
            logger.warning("Cached file is not a valid PDF, deleting: %s", cache)
            cache.unlink(missing_ok=True)
            return ""
    else:
        pdf_bytes = await _download(session, url, pdf=True)
        if not _is_valid_pdf(pdf_bytes):
            logger.warning("Downloaded data from %s is not a valid PDF (header: %r)", url, pdf_bytes[:16])
            cache.unlink(missing_ok=True)
            return ""
        cache.write_bytes(pdf_bytes)
    return await asyncio.to_thread(_extract_pdf_text, pdf_bytes)


async def _fetch_webpage(session: aiohttp.ClientSession, url: str) -> str:
    raw = await _download(session, url)
    html = raw.decode("utf-8", errors="replace")
    return await asyncio.to_thread(_extract_webpage_text, html)


async def _fetch_unpaywall_pdf(session: aiohttp.ClientSession, doi: str) -> str:
    """Query Unpaywall for an OA PDF link, then download and extract."""
    email = config.UNPAYWALL_EMAIL
    if not email or not doi:
        return ""
    url = f"https://api.unpaywall.org/v2/{doi}?email={email}"
    data = await _download_json(session, url)
    if not data:
        return ""

    best_url = None
    best_loc = data.get("best_oa_location") or {}
    best_url = best_loc.get("url_for_pdf") or best_loc.get("url")

    if not best_url:
        for loc in data.get("oa_locations") or []:
            candidate = loc.get("url_for_pdf") or loc.get("url", "")
            if candidate:
                best_url = candidate
                break

    if not best_url:
        return ""

    logger.debug("Unpaywall found OA link for %s: %s", doi, best_url)
    if best_url.lower().endswith(".pdf") or "pdf" in best_url.lower():
        try:
            return await _fetch_pdf(session, best_url)
        except Exception:
            pass

    try:
        return await _fetch_webpage(session, best_url)
    except Exception:
        pass
    return ""


async def _fetch_pmc_text(session: aiohttp.ClientSession, pmcid: str) -> str:
    """Fetch full text from PubMed Central via the OAI-PMH endpoint."""
    if not pmcid:
        return ""
    numeric = pmcid.replace("PMC", "")
    url = (
        f"https://www.ncbi.nlm.nih.gov/pmc/oai/oai.cgi"
        f"?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:{numeric}"
        f"&metadataPrefix=pmc"
    )
    try:
        raw = await _download(session, url, timeout=30)
        xml_text = raw.decode("utf-8", errors="replace")
        text = _extract_pmc_xml_text(xml_text)
        if len(text.strip()) > _MIN_USEFUL_TEXT:
            return text[:config.MAX_TEXT_LEN]
    except Exception as e:
        logger.debug("PMC fetch failed for %s: %s", pmcid, e)
    return ""


def _extract_pmc_xml_text(xml: str) -> str:
    """Extract readable text from PMC OAI-PMH XML response."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(xml, "html.parser")

    body = soup.find("body")
    if body:
        for tag in body.find_all(["table", "graphic", "inline-formula", "disp-formula"]):
            tag.decompose()
        return body.get_text(separator="\n", strip=True)

    article = soup.find("article")
    if article:
        return article.get_text(separator="\n", strip=True)

    return ""


async def _fetch_crossref_abstract(session: aiohttp.ClientSession, doi: str) -> str:
    """Fetch a fuller abstract from CrossRef metadata API."""
    if not doi:
        return ""
    url = f"https://api.crossref.org/works/{doi}"
    data = await _download_json(session, url)
    if not data:
        return ""
    abstract = data.get("message", {}).get("abstract", "")
    if abstract:
        clean = re.sub(r"<[^>]+>", "", abstract).strip()
        return clean
    return ""


async def _fetch_s2_oa_pdf(session: aiohttp.ClientSession, doi: str) -> str:
    """Try Semantic Scholar's openAccessPdf URL for full text."""
    if not doi:
        return ""
    url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=abstract,title,openAccessPdf"
    data = await _download_json(session, url, timeout=15)
    if not data:
        return ""
    oa = data.get("openAccessPdf") or {}
    pdf_url = oa.get("url", "")
    if pdf_url:
        try:
            text = await _fetch_pdf(session, pdf_url)
            if text:
                return text
        except Exception:
            pass
        try:
            text = await _fetch_webpage(session, pdf_url)
            if text and _is_useful_webpage_text(text):
                return text
        except Exception:
            pass
    return ""


async def _fetch_semantic_scholar_abstract(session: aiohttp.ClientSession, doi: str) -> str:
    """Fetch abstract from Semantic Scholar API (free, no key required)."""
    if not doi:
        return ""
    url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=abstract,title"
    data = await _download_json(session, url, timeout=15)
    if not data:
        return ""
    abstract = data.get("abstract") or ""
    return abstract.strip()


async def _resolve_pmcid(session: aiohttp.ClientSession, doi: str) -> str:
    """Resolve a DOI to a PMCID via the NCBI ID Converter API."""
    if not doi:
        return ""
    url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids={doi}&format=json"
    data = await _download_json(session, url, timeout=15)
    if not data:
        return ""
    for rec in data.get("records") or []:
        pmcid = rec.get("pmcid", "")
        if pmcid:
            return pmcid
    return ""


async def _fetch_core_fulltext(session: aiohttp.ClientSession, doi: str) -> str:
    """Fetch full text from CORE.ac.uk aggregator (free, no key required for basic use)."""
    if not doi:
        return ""
    url = f"https://api.core.ac.uk/v3/search/works/?q=doi%3A%22{doi}%22&limit=1"
    data = await _download_json(session, url, timeout=20)
    if not data:
        return ""
    results = data.get("results") or []
    if not results:
        return ""
    fulltext = results[0].get("fullText") or ""
    if len(fulltext.strip()) > _MIN_USEFUL_TEXT:
        return fulltext[:config.MAX_TEXT_LEN]
    return ""


# ── Main fetch logic ─────────────────────────────────────────────────────────


def _is_useful_webpage_text(text: str) -> bool:
    """Reject garbage webpage extractions (cookie walls, nav menus, etc.)."""
    if len(text.strip()) < _MIN_USEFUL_TEXT:
        return False
    lines = text.strip().splitlines()
    if len(lines) < 3:
        return False
    avg_line_len = sum(len(l) for l in lines) / len(lines)
    if avg_line_len < 20:
        return False
    garbage_markers = [
        "cookie", "javascript", "enable javascript", "your browser",
        "access denied", "sign in", "log in", "subscribe",
        "captcha", "verify you are human", "cloudflare",
    ]
    lower = text[:500].lower()
    if sum(1 for m in garbage_markers if m in lower) >= 2:
        return False
    return True


async def fetch_one(
    session: aiohttp.ClientSession,
    sem: asyncio.Semaphore,
    paper: dict,
    on_activity: Any = None,
    paper_idx: int = 0,
    paper_total: int = 0,
) -> dict:
    """Fetch text for a single paper using the 9-step chain.

    403 errors from publisher sites are caught and treated as "skip this
    strategy" rather than fatal — the chain continues to the next source.
    """
    def _emit(msg: str) -> None:
        if on_activity:
            try:
                on_activity(msg)
            except Exception:
                pass

    async with sem:
        text = ""
        text_source = "none"
        doi = paper.get("doi", "")
        pmcid = paper.get("pmcid", "")
        title_short = paper.get("title", "?")[:40]
        tag = f"[{paper_idx}/{paper_total}]" if paper_total else ""

        _emit(f"获取全文 {tag} {title_short}...")

        # 1. PDF from search result
        if paper.get("pdf_url"):
            try:
                if doi:
                    await _warm_session(session, _doi_to_article_url(doi))
                text = await _fetch_pdf(session, paper["pdf_url"])
                if text:
                    text_source = "pdf"
            except _ForbiddenError:
                logger.debug("PDF 403 for %s, skipping to next source", title_short)
            except Exception as e:
                logger.warning("PDF fetch failed for %s: %s", title_short, e)

        # 2. Unpaywall OA PDF lookup
        if not text and doi:
            try:
                text = await _fetch_unpaywall_pdf(session, doi)
                if text:
                    text_source = "unpaywall"
            except _ForbiddenError:
                logger.debug("Unpaywall 403 for %s, skipping", doi)
            except Exception as e:
                logger.warning("Unpaywall failed for %s: %s", doi, e)

        # 3. Semantic Scholar open-access PDF
        if not text and doi:
            try:
                text = await _fetch_s2_oa_pdf(session, doi)
                if text:
                    text_source = "s2_oa_pdf"
            except _ForbiddenError:
                logger.debug("S2 OA PDF 403 for %s, skipping", doi)
            except Exception as e:
                logger.warning("S2 OA PDF failed for %s: %s", doi, e)

        # 4. PubMed Central XML (resolve PMCID from DOI if needed)
        if not text and doi and not pmcid:
            try:
                pmcid = await _resolve_pmcid(session, doi)
            except Exception as e:
                logger.debug("PMCID lookup failed for %s: %s", doi, e)
        if not text and pmcid:
            try:
                text = await _fetch_pmc_text(session, pmcid)
                if text:
                    text_source = "pmc"
            except Exception as e:
                logger.warning("PMC failed for %s: %s", pmcid, e)

        # 5. CORE.ac.uk full text
        if not text and doi:
            try:
                text = await _fetch_core_fulltext(session, doi)
                if text:
                    text_source = "core"
            except Exception as e:
                logger.warning("CORE failed for %s: %s", doi, e)

        # 6. Webpage (DOI landing page) — with quality filter
        if not text and paper.get("web_url"):
            try:
                await _warm_session(session, paper["web_url"])
                candidate = await _fetch_webpage(session, paper["web_url"])
                if candidate and _is_useful_webpage_text(candidate):
                    text = candidate
                    text_source = "webpage"
                elif candidate:
                    logger.debug("Webpage text rejected as garbage for %s (%d chars)",
                                 title_short, len(candidate))
            except _ForbiddenError:
                logger.debug("Webpage 403 for %s, skipping", title_short)
            except Exception as e:
                logger.warning("Webpage fetch failed for %s: %s", title_short, e)

        # 6b. DOI landing page as webpage (if web_url wasn't the DOI page)
        if not text and doi:
            doi_url = _doi_to_article_url(doi)
            if doi_url != paper.get("web_url", ""):
                try:
                    candidate = await _fetch_webpage(session, doi_url)
                    if candidate and _is_useful_webpage_text(candidate):
                        text = candidate
                        text_source = "doi_webpage"
                except _ForbiddenError:
                    pass
                except Exception:
                    pass

        # 7. CrossRef full abstract
        if not text and doi:
            try:
                text = await _fetch_crossref_abstract(session, doi)
                if text:
                    text_source = "crossref_abstract"
            except Exception as e:
                logger.warning("CrossRef abstract failed for %s: %s", doi, e)

        # 8. Semantic Scholar abstract
        if not text and doi:
            try:
                text = await _fetch_semantic_scholar_abstract(session, doi)
                if text:
                    text_source = "s2_abstract"
            except Exception as e:
                logger.warning("Semantic Scholar abstract failed for %s: %s", doi, e)

        # 9. Search abstract (last resort)
        if not text:
            text = paper.get("abstract") or ""
            if text:
                text_source = "search_abstract"

        return {**paper, "text": text, "text_source": text_source}


def _build_connector(max_concurrent: int) -> aiohttp.BaseConnector:
    """Build a TCP or proxy connector depending on config.

    SSL verification is only disabled when a proxy is configured, since
    proxies often use self-signed certs. Direct connections keep SSL on.
    """
    proxy = config.HTTP_PROXY
    if proxy:
        try:
            from aiohttp_socks import ProxyConnector
            logger.info("Using proxy: %s", proxy)
            return ProxyConnector.from_url(proxy, limit=max_concurrent, limit_per_host=5, ssl=False)
        except ImportError:
            logger.warning("HTTP_PROXY is set but aiohttp-socks is not installed; ignoring proxy")
    return aiohttp.TCPConnector(limit=max_concurrent, limit_per_host=5)


async def fetch_all(
    papers: list[dict],
    max_concurrent: int | None = None,
    on_activity: Any = None,
) -> list[dict]:
    """Concurrently fetch text for all papers.

    Individual paper failures are caught and returned with text_source="none"
    so one broken paper never crashes the entire batch.
    """
    max_concurrent = max_concurrent or config.FETCH_CONCURRENCY
    sem = asyncio.Semaphore(max_concurrent)
    connector = _build_connector(max_concurrent)
    jar = aiohttp.CookieJar(unsafe=True)
    total = len(papers)

    async with aiohttp.ClientSession(connector=connector, cookie_jar=jar) as session:
        tasks = [
            fetch_one(session, sem, p, on_activity=on_activity, paper_idx=i + 1, paper_total=total)
            for i, p in enumerate(papers)
        ]
        raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[dict] = []
    for i, r in enumerate(raw_results):
        if isinstance(r, Exception):
            logger.warning("fetch_one failed for paper %d (%s): %s",
                           i, papers[i].get("title", "?")[:40], r)
            results.append({**papers[i], "text": "", "text_source": "none"})
        else:
            results.append(r)
    return results
