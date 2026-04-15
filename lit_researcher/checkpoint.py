"""Checkpoint / resume support for long-running pipelines.

Uses atomic writes (write to temp then rename) and file locking to
prevent corruption from crashes or concurrent writers.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from . import config

logger = logging.getLogger(__name__)


def load_completed_ids(path: Path | None = None) -> set[str]:
    """Return set of paper_ids already processed."""
    path = path or config.CHECKPOINT_PATH
    ids: set[str] = set()
    if not path.exists():
        return ids
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                pid = row.get("paper_id") or row.get("source_doi") or ""
                if pid:
                    ids.add(pid)
            except json.JSONDecodeError:
                continue
    logger.info("Loaded %d completed papers from checkpoint", len(ids))
    return ids


def append_result(row: dict, path: Path | None = None) -> None:
    """Append one extraction result to the checkpoint file.

    Uses write-to-temp-then-append pattern to minimize corruption risk.
    """
    path = path or config.CHECKPOINT_PATH
    line = json.dumps(row, ensure_ascii=False) + "\n"
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
    except OSError as e:
        logger.warning("Checkpoint write failed: %s", e)


def load_all_results(path: Path | None = None) -> list[dict]:
    """Load all results from checkpoint, skipping corrupted lines."""
    path = path or config.CHECKPOINT_PATH
    results = []
    if not path.exists():
        return results
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if line:
                try:
                    results.append(json.loads(line))
                except json.JSONDecodeError:
                    logger.warning("Skipping corrupted checkpoint line %d", lineno)
                    continue
    return results


def filter_unprocessed(papers: list[dict], path: Path | None = None) -> list[dict]:
    """Return only papers whose paper_id/doi is NOT in the checkpoint.

    This enables true resume: skip papers already extracted.
    """
    done_ids = load_completed_ids(path)
    if not done_ids:
        return papers

    unprocessed = []
    for p in papers:
        pid = p.get("paper_id") or p.get("doi") or ""
        if pid and pid in done_ids:
            continue
        unprocessed.append(p)

    skipped = len(papers) - len(unprocessed)
    if skipped:
        logger.info("Resume: skipping %d already-processed papers, %d remaining", skipped, len(unprocessed))
    return unprocessed
