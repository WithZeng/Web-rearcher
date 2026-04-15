"""Helpers for importing and parsing local PDF files."""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
from collections.abc import Callable
from typing import Any

from pypdf import PdfReader

from .fetch import _extract_pdf_text, _is_valid_pdf


def _title_from_filename(filename: str) -> str:
    stem = filename.rsplit(".", 1)[0]
    cleaned = re.sub(r"[_-]+", " ", stem)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or filename or "Untitled PDF"


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
) -> list[dict[str, Any]]:
    """Parse uploaded PDF files into pipeline-ready paper objects."""

    sem = asyncio.Semaphore(max(1, max_concurrent))
    total = len(files)

    async def _run_one(index: int, file_name: str, pdf_bytes: bytes) -> tuple[int, dict[str, Any]]:
        async with sem:
            paper = await asyncio.to_thread(_extract_single_pdf, file_name, pdf_bytes)
            return index, paper

    tasks = [
        asyncio.create_task(_run_one(index, file_name, pdf_bytes))
        for index, (file_name, pdf_bytes) in enumerate(files)
    ]

    results: list[dict[str, Any] | None] = [None] * total
    done = 0
    for task in asyncio.as_completed(tasks):
        index, paper = await task
        results[index] = paper
        done += 1
        if on_progress:
            on_progress(done, total, paper)

    return [paper for paper in results if paper is not None]
