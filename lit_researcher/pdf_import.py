"""Helpers for importing and parsing local PDF files."""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pypdf import PdfReader

from . import config
from .fetch import _extract_pdf_text, _is_valid_pdf


@dataclass(frozen=True)
class ServerPdfEntry:
    path: str
    name: str
    size: int
    modified_at: str


def _title_from_filename(filename: str) -> str:
    stem = filename.rsplit(".", 1)[0]
    cleaned = re.sub(r"[_-]+", " ", stem)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or filename or "Untitled PDF"


def _pdf_root() -> Path:
    return config.PDF_CACHE_DIR.resolve()


def _resolve_server_pdf(relative_path: str) -> Path:
    root = _pdf_root()
    normalized = (relative_path or "").strip().replace("\\", "/")
    if not normalized:
        raise ValueError("PDF path is required")
    if normalized.startswith("/") or normalized.startswith("..") or "/../" in f"/{normalized}/":
        raise ValueError("Invalid PDF path")

    candidate = (root / normalized).resolve()
    if candidate.suffix.lower() != ".pdf":
        raise ValueError("Only PDF files are supported")
    if root != candidate and root not in candidate.parents:
        raise ValueError("PDF path escapes the allowed directory")
    if not candidate.exists():
        raise FileNotFoundError(normalized)
    if not candidate.is_file():
        raise ValueError("Selected path is not a file")
    return candidate


def list_server_pdfs() -> list[ServerPdfEntry]:
    root = _pdf_root()
    entries: list[ServerPdfEntry] = []
    for path in sorted(root.rglob("*.pdf"), key=lambda item: item.stat().st_mtime, reverse=True):
        stat = path.stat()
        entries.append(
            ServerPdfEntry(
                path=path.relative_to(root).as_posix(),
                name=path.name,
                size=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
            )
        )
    return entries


def load_server_pdf_inputs(paths: list[str]) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []
    for rel_path in paths:
        resolved = _resolve_server_pdf(rel_path)
        files.append((resolved.name, resolved.read_bytes()))
    return files


def _extract_single_pdf(file_name: str, pdf_bytes: bytes) -> dict[str, Any]:
    title = _title_from_filename(file_name)
    paper_id = f"pdf:{hashlib.sha1((file_name).encode('utf-8') + pdf_bytes).hexdigest()[:16]}"

    if not pdf_bytes:
        return {
            "paper_id": paper_id,
            "title": title,
            "doi": "",
            "text": "",
            "text_source": "none",
            "file_name": file_name,
            "parse_error": "文件为空",
        }

    if not _is_valid_pdf(pdf_bytes):
        return {
            "paper_id": paper_id,
            "title": title,
            "doi": "",
            "text": "",
            "text_source": "none",
            "file_name": file_name,
            "parse_error": "文件不是有效的 PDF",
        }

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        meta_title = str((reader.metadata or {}).get("/Title") or "").strip()
        if meta_title:
            title = meta_title
    except Exception:
        pass

    try:
        text = _extract_pdf_text(pdf_bytes)
    except Exception as exc:
        return {
            "paper_id": paper_id,
            "title": title,
            "doi": "",
            "text": "",
            "text_source": "none",
            "file_name": file_name,
            "parse_error": f"PDF 解析失败: {exc}",
        }

    normalized_text = (text or "").strip()
    if not normalized_text:
        return {
            "paper_id": paper_id,
            "title": title,
            "doi": "",
            "text": "",
            "text_source": "none",
            "file_name": file_name,
            "parse_error": "未能从 PDF 中提取到文本",
        }

    return {
        "paper_id": paper_id,
        "title": title,
        "doi": "",
        "text": normalized_text,
        "text_source": "pdf",
        "file_name": file_name,
        "parse_error": None,
    }


async def extract_uploaded_pdfs(
    files: list[tuple[str, bytes]],
    on_progress: Callable[[int, int, dict[str, Any]], None] | None = None,
    max_concurrent: int = 2,
    cancel_check: Callable[[], None] | None = None,
) -> list[dict[str, Any]]:
    """Parse uploaded PDF files into pipeline-ready paper objects."""

    sem = asyncio.Semaphore(max(1, max_concurrent))
    total = len(files)

    async def _run_one(index: int, file_name: str, pdf_bytes: bytes) -> tuple[int, dict[str, Any]]:
        async with sem:
            if cancel_check:
                cancel_check()
            paper = await asyncio.to_thread(_extract_single_pdf, file_name, pdf_bytes)
            if cancel_check:
                cancel_check()
            return index, paper

    tasks = [
        asyncio.create_task(_run_one(index, file_name, pdf_bytes))
        for index, (file_name, pdf_bytes) in enumerate(files)
    ]

    results: list[dict[str, Any] | None] = [None] * total
    done = 0
    for task in asyncio.as_completed(tasks):
        if cancel_check:
            cancel_check()
        index, paper = await task
        results[index] = paper
        done += 1
        if on_progress:
            on_progress(done, total, paper)

    return [paper for paper in results if paper is not None]
