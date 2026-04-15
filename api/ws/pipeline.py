from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from lit_researcher.agents.base import PipelineContext
from lit_researcher.agents.orchestrator import run_pipeline
from lit_researcher.ui_helpers import (
    dois_to_papers,
    save_task,
)
from lit_researcher.fetch import fetch_all
from lit_researcher.extract import extract_batch, extract_batch_with_progress
from lit_researcher.pdf_import import extract_uploaded_pdfs

logger = logging.getLogger(__name__)
router = APIRouter()

STAGE_META: dict[str, tuple[float, str]] = {
    "planner":              (0.05, "规划搜索策略"),
    "search":               (0.15, "检索文献"),
    "retrieval":            (0.35, "获取全文"),
    "quality_filter":       (0.50, "质量筛选"),
    "extraction":           (0.70, "统一提取"),
    "extraction_sub_agents":(0.75, "子智能体提取"),
    "extraction_merge":     (0.80, "合并提取结果"),
    "reviewer":             (0.90, "审查校验"),
    "reviewer_retry":       (0.95, "重试审查"),
    "done":                 (1.00, "完成"),
    "error":                (1.00, "出错"),
}

_TASK_EXPIRE_SECONDS = 1800  # 30 min after completion
_MAX_CONCURRENT_TASKS = 3


class CancelledByUser(Exception):
    """Raised inside the pipeline when the user clicks cancel."""


@dataclass
class PipelineTask:
    task: asyncio.Task | None = None
    ws_connections: set[WebSocket] = field(default_factory=set)
    messages: list[dict] = field(default_factory=list)
    result: list[dict] | None = None
    error: str | None = None
    cancelled: bool = False
    created_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None


_pipeline_tasks: dict[str, PipelineTask] = {}


def _purge_expired_tasks() -> int:
    """Remove completed tasks older than _TASK_EXPIRE_SECONDS. Returns count removed."""
    now = time.monotonic()
    expired = [
        tid for tid, entry in _pipeline_tasks.items()
        if entry.finished_at is not None
        and (now - entry.finished_at) > _TASK_EXPIRE_SECONDS
        and not entry.ws_connections
    ]
    for tid in expired:
        del _pipeline_tasks[tid]
    if expired:
        logger.info("Purged %d expired pipeline tasks", len(expired))
    return len(expired)


def _count_running_tasks() -> int:
    return sum(
        1 for entry in _pipeline_tasks.values()
        if entry.task is not None and not entry.task.done()
    )


def _build_stage_msg(stage: str, ctx: PipelineContext | None = None, detail: str | None = None) -> dict:
    progress, label = STAGE_META.get(stage, (0.0, stage))
    msg: dict[str, Any] = {
        "type": "stage",
        "stage": stage,
        "progress": progress,
        "label": label,
    }
    if ctx is not None:
        msg["papers_found"] = len(ctx.papers)
        msg["papers_passed"] = len(ctx.passed_papers)
        msg["rows_extracted"] = len(ctx.rows)
        msg["rows_reviewed"] = len(ctx.reviewed_rows)
    if detail:
        msg["detail"] = detail
    return msg


async def _broadcast(task_id: str, msg: dict, *, ephemeral: bool = False) -> None:
    """Broadcast a message to all WebSocket connections for a task.

    If *ephemeral* is True the message is sent but NOT stored in the replay
    buffer (used for high-frequency activity messages).
    """
    entry = _pipeline_tasks.get(task_id)
    if entry is None:
        return
    if not ephemeral:
        entry.messages.append(msg)
    payload = json.dumps(msg, ensure_ascii=False)
    dead: list[WebSocket] = []
    for ws in entry.ws_connections:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        entry.ws_connections.discard(ws)


async def _run_pipeline_task(
    task_id: str,
    query: str,
    limit: int | None,
    databases: list[str] | None,
    fetch_concurrency: int | None,
    llm_concurrency: int | None,
    use_planner: bool,
    max_retries: int,
    mode: str,
    resume: bool,
) -> None:
    entry = _pipeline_tasks[task_id]
    try:

        _pending_broadcasts: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def _check_cancel() -> None:
            if entry.cancelled:
                raise CancelledByUser()

        def on_stage(stage: str, ctx: PipelineContext) -> None:
            _check_cancel()
            msg = _build_stage_msg(stage, ctx)
            t = loop.create_task(_broadcast(task_id, msg))
            _pending_broadcasts.append(t)

        def on_activity(text: str) -> None:
            _check_cancel()
            loop.create_task(_broadcast(task_id, {"type": "activity", "text": text}, ephemeral=True))

        rows = await run_pipeline(
            query=query,
            limit=limit,
            databases=databases,
            fetch_concurrency=fetch_concurrency,
            llm_concurrency=llm_concurrency,
            use_planner=use_planner,
            on_stage=on_stage,
            on_activity=on_activity,
            max_retries=max_retries,
            mode=mode,
            resume=resume,
            cancel_check=_check_cancel,
        )

        if entry.cancelled:
            raise CancelledByUser()

        from lit_researcher.output import filter_empty_rows
        from lit_researcher.blacklist import add_to_blacklist
        kept, discarded = filter_empty_rows(rows)
        failed_dois = [r.get("source_doi") for r in discarded if r.get("source_doi") and r.get("text_source") == "none"]
        if failed_dois:
            add_to_blacklist(failed_dois)

        entry.result = kept
        save_task(query, kept, databases=databases)
        if _pending_broadcasts:
            await asyncio.gather(*_pending_broadcasts, return_exceptions=True)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"共 {len(kept)} 条结果"))
    except (asyncio.CancelledError, CancelledByUser):
        entry.cancelled = True
        if not entry.error:
            entry.error = "用户取消"
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "已取消",
            "detail": "任务已取消",
        })
    except Exception as exc:
        entry.error = str(exc)
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "出错",
            "detail": str(exc),
        })
    finally:
        entry.finished_at = time.monotonic()


async def _run_doi_task(
    task_id: str,
    dois: list[str],
    mode: str,
    fetch_concurrency: int | None,
    llm_concurrency: int | None,
) -> None:
    entry = _pipeline_tasks[task_id]
    try:
        papers = dois_to_papers(dois)

        await _broadcast(task_id, _build_stage_msg("retrieval"))
        papers = await fetch_all(papers, max_concurrent=fetch_concurrency)

        await _broadcast(task_id, _build_stage_msg("extraction"))
        rows = await extract_batch(papers, max_concurrent=llm_concurrency)

        from lit_researcher.agents.reviewer import ReviewerAgent
        from lit_researcher.agents.base import PipelineContext
        from lit_researcher.output import filter_empty_rows
        from lit_researcher.blacklist import add_to_blacklist
        from lit_researcher.pubchem import batch_lookup, enrich_row
        from lit_researcher.extract import _compute_data_quality

        # PubChem enrichment for DOI import
        drug_names: set[str] = set()
        for r in rows:
            name = str(r.get("drug_name") or "").strip()
            if name:
                drug_names.add(name)
        if drug_names:
            await _broadcast(task_id, {"type": "activity", "text": f"PubChem 查询 {len(drug_names)} 种药物..."}, ephemeral=True)
            pc_cache, _pc_stats = await batch_lookup(drug_names)
            for r in rows:
                name = str(r.get("drug_name") or "").strip()
                if name and name in pc_cache and pc_cache[name]:
                    n = enrich_row(r, pc_cache[name])
                    if n:
                        r["_data_quality"] = _compute_data_quality(r)

        await _broadcast(task_id, _build_stage_msg("reviewer"))
        review_ctx = PipelineContext(
            query=f"DOI import ({len(dois)} papers)",
            limit=len(dois),
            databases=[],
            fetch_concurrency=fetch_concurrency or 15,
            llm_concurrency=llm_concurrency or 5,
            mode=mode,
        )
        review_ctx.rows = rows
        review_ctx = await ReviewerAgent().run_timed(review_ctx)
        reviewed = review_ctx.reviewed_rows if review_ctx.reviewed_rows else rows

        kept, discarded = filter_empty_rows(reviewed)
        failed_dois = [r.get("source_doi") for r in discarded if r.get("source_doi") and r.get("text_source") == "none"]
        if failed_dois:
            add_to_blacklist(failed_dois)

        entry.result = kept
        save_task(f"DOI import ({len(dois)} papers)", kept)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"共 {len(kept)} 条结果"))
    except (asyncio.CancelledError, CancelledByUser):
        entry.cancelled = True
        if not entry.error:
            entry.error = "用户取消"
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "已取消",
            "detail": "任务已取消",
        })
    except Exception as exc:
        entry.error = str(exc)
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "出错",
            "detail": str(exc),
        })
    finally:
        entry.finished_at = time.monotonic()


def _build_pdf_skip_row(paper: dict[str, Any], reason: str) -> dict[str, Any]:
    quality_scores = paper.get("_quality_scores", {}) or {}
    return {
        "paper_id": paper.get("paper_id", ""),
        "source_title": paper.get("title", ""),
        "source_doi": paper.get("doi", ""),
        "text_source": paper.get("text_source", "none"),
        "_data_quality": 0.0,
        "_review": "low_quality",
        "_review_score": 0,
        "_review_flags": reason,
        "_skip_reason": reason,
        "_quality_label": quality_scores.get("quality_label", "low_value"),
        "_quality_total": quality_scores.get("total_score", 0.0),
    }


async def _run_pdf_task(
    task_id: str,
    files: list[tuple[str, bytes]],
    mode: str,
    llm_concurrency: int | None,
) -> None:
    entry = _pipeline_tasks[task_id]
    try:
        total_files = len(files)
        await _broadcast(task_id, {
            "type": "activity",
            "text": f"开始解析 {total_files} 个本地 PDF 文件...",
        }, ephemeral=True)

        def on_pdf_progress(done: int, total: int, paper: dict[str, Any]) -> None:
            status = "完成" if not paper.get("parse_error") else "失败"
            title = str(paper.get("title") or paper.get("file_name") or "Untitled PDF")
            asyncio.get_running_loop().create_task(_broadcast(
                task_id,
                {"type": "activity", "text": f"PDF 解析 [{done}/{total}] {status}: {title[:60]}"},
                ephemeral=True,
            ))

        papers = await extract_uploaded_pdfs(files, on_progress=on_pdf_progress)

        ctx = PipelineContext(
            query=f"PDF import ({total_files} files)",
            limit=total_files,
            databases=[],
            fetch_concurrency=2,
            llm_concurrency=llm_concurrency or 5,
            mode=mode,
        )
        ctx.papers = papers
        ctx.papers_with_text = papers
        await _broadcast(task_id, _build_stage_msg("retrieval", ctx, detail=f"已解析 {len(papers)} 个 PDF"))

        from lit_researcher.agents.quality_filter import QualityFilterAgent
        from lit_researcher.agents.reviewer import ReviewerAgent

        ctx = await QualityFilterAgent().run_timed(ctx)
        await _broadcast(task_id, _build_stage_msg("quality_filter", ctx))

        async def on_extract_complete(done: int, total: int, row: dict[str, Any]) -> None:
            await _broadcast(
                task_id,
                {
                    "type": "activity",
                    "text": f"字段提取 [{done}/{total}] {str(row.get('source_title') or 'Untitled PDF')[:60]}",
                },
                ephemeral=True,
            )

        if ctx.passed_papers:
            rows = await extract_batch_with_progress(
                ctx.passed_papers,
                on_complete=lambda done, total, row: asyncio.get_running_loop().create_task(
                    on_extract_complete(done, total, row),
                ),
                max_concurrent=llm_concurrency,
            )
        else:
            rows = []

        quality_by_paper_id = {
            paper.get("paper_id", ""): paper.get("_quality_scores", {}) or {}
            for paper in ctx.passed_papers
        }
        for row in rows:
            scores = quality_by_paper_id.get(str(row.get("paper_id", "")), {})
            row["_quality_label"] = scores.get("quality_label", "medium_value")
            row["_quality_total"] = scores.get("total_score", 0.0)

        ctx.rows = rows
        await _broadcast(task_id, _build_stage_msg("extraction", ctx))

        if ctx.rows:
            ctx = await ReviewerAgent().run_timed(ctx)
            await _broadcast(task_id, _build_stage_msg("reviewer", ctx))

        reviewed_by_paper_id = {
            str(row.get("paper_id", "")): row
            for row in (ctx.reviewed_rows if ctx.reviewed_rows else ctx.rows)
        }

        result_rows: list[dict[str, Any]] = []
        for paper in papers:
            paper_id = str(paper.get("paper_id", ""))
            if paper_id in reviewed_by_paper_id:
                result_rows.append(reviewed_by_paper_id[paper_id])
                continue

            if paper.get("parse_error"):
                result_rows.append(_build_pdf_skip_row(paper, str(paper["parse_error"])))
                continue

            scores = paper.get("_quality_scores", {}) or {}
            if scores.get("quality_label") == "low_value" or paper in ctx.failed_papers:
                result_rows.append(_build_pdf_skip_row(paper, "未通过质量筛选"))
                continue

            result_rows.append(_build_pdf_skip_row(paper, "未能生成提取结果"))

        entry.result = result_rows
        save_task(f"PDF import ({total_files} files)", result_rows)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"共 {len(result_rows)} 条结果"))
    except (asyncio.CancelledError, CancelledByUser):
        entry.cancelled = True
        if not entry.error:
            entry.error = "用户取消"
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "已取消",
            "detail": "任务已取消",
        })
    except Exception as exc:
        entry.error = str(exc)
        await _broadcast(task_id, {
            "type": "stage",
            "stage": "error",
            "progress": 1.0,
            "label": "出错",
            "detail": str(exc),
        })
    finally:
        entry.finished_at = time.monotonic()


def start_pipeline_task(
    query: str,
    limit: int | None = None,
    databases: list[str] | None = None,
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
    use_planner: bool = True,
    max_retries: int = 1,
    mode: str = "multi",
    resume: bool = False,
) -> str:
    _purge_expired_tasks()
    if _count_running_tasks() >= _MAX_CONCURRENT_TASKS:
        raise RuntimeError(f"已达到最大并发任务数 ({_MAX_CONCURRENT_TASKS})，请等待当前任务完成")
    task_id = uuid.uuid4().hex
    entry = PipelineTask()
    _pipeline_tasks[task_id] = entry
    entry.task = asyncio.get_running_loop().create_task(
        _run_pipeline_task(
            task_id, query, limit, databases,
            fetch_concurrency, llm_concurrency,
            use_planner, max_retries, mode, resume,
        )
    )
    return task_id


def start_doi_task(
    dois: list[str],
    mode: str = "multi",
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
) -> str:
    _purge_expired_tasks()
    if _count_running_tasks() >= _MAX_CONCURRENT_TASKS:
        raise RuntimeError(f"已达到最大并发任务数 ({_MAX_CONCURRENT_TASKS})，请等待当前任务完成")
    task_id = uuid.uuid4().hex
    entry = PipelineTask()
    _pipeline_tasks[task_id] = entry
    entry.task = asyncio.get_running_loop().create_task(
        _run_doi_task(task_id, dois, mode, fetch_concurrency, llm_concurrency)
    )
    return task_id


def start_pdf_task(
    files: list[tuple[str, bytes]],
    mode: str = "multi",
    llm_concurrency: int | None = None,
) -> str:
    _purge_expired_tasks()
    if _count_running_tasks() >= _MAX_CONCURRENT_TASKS:
        raise RuntimeError(f"已达到最大并发任务数 ({_MAX_CONCURRENT_TASKS})，请等待当前任务完成")
    task_id = uuid.uuid4().hex
    entry = PipelineTask()
    _pipeline_tasks[task_id] = entry
    entry.task = asyncio.get_running_loop().create_task(
        _run_pdf_task(task_id, files, mode, llm_concurrency)
    )
    return task_id


def cancel_task(task_id: str) -> bool:
    """Cancel a running pipeline task. Returns True if cancelled."""
    entry = _pipeline_tasks.get(task_id)
    if entry is None:
        return False
    if entry.task is not None and not entry.task.done():
        entry.cancelled = True
        entry.task.cancel()
        entry.error = "用户取消"
        entry.finished_at = time.monotonic()
        return True
    return False


def is_task_cancelled(task_id: str) -> bool:
    """Check if a task has been cancelled (callable from pipeline stages)."""
    entry = _pipeline_tasks.get(task_id)
    return entry is not None and entry.cancelled


def get_task(task_id: str) -> PipelineTask | None:
    return _pipeline_tasks.get(task_id)


@router.websocket("/ws/pipeline/{task_id}")
async def ws_pipeline(websocket: WebSocket, task_id: str):
    entry = _pipeline_tasks.get(task_id)
    if entry is None:
        await websocket.close(code=4004, reason="task not found")
        return

    await websocket.accept()
    entry.ws_connections.add(websocket)

    for msg in entry.messages:
        try:
            await websocket.send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            break

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        entry.ws_connections.discard(websocket)
