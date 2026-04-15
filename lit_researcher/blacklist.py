"""DOI blacklist — skip papers that repeatedly fail to fetch."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from . import config

logger = logging.getLogger(__name__)

_BLACKLIST_PATH = config.OUTPUT_DIR / "blacklist.json"


def load_blacklist() -> set[str]:
    if not _BLACKLIST_PATH.exists():
        return set()
    try:
        data = json.loads(_BLACKLIST_PATH.read_text(encoding="utf-8"))
        return set(data)
    except (json.JSONDecodeError, ValueError):
        return set()


def add_to_blacklist(dois: list[str]) -> int:
    bl = load_blacklist()
    new_dois = [d for d in dois if d and d not in bl]
    if not new_dois:
        return 0
    bl.update(new_dois)
    _BLACKLIST_PATH.write_text(
        json.dumps(sorted(bl), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info("Added %d DOIs to blacklist (total: %d)", len(new_dois), len(bl))
    return len(new_dois)


def filter_blacklisted(papers: list[dict]) -> list[dict]:
    bl = load_blacklist()
    if not bl:
        return papers
    before = len(papers)
    result = [p for p in papers if (p.get("doi") or "") not in bl]
    skipped = before - len(result)
    if skipped:
        logger.info("Blacklist: skipped %d papers, %d remaining", skipped, len(result))
    return result


def clear_blacklist() -> int:
    bl = load_blacklist()
    count = len(bl)
    if _BLACKLIST_PATH.exists():
        _BLACKLIST_PATH.unlink()
    return count


def blacklist_count() -> int:
    return len(load_blacklist())
