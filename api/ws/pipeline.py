from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from lit_researcher.agents.base import PipelineContext
from lit_researcher.agents.orchestrator import run_pipeline
from lit_researcher.extract import extract_batch, extract_batch_with_progress
from lit_researcher.fetch import fetch_all
from lit_researcher.pdf_import import extract_uploaded_pdfs
from lit_researcher.ui_helpers import dois_to_papers, save_task

logger = logging.getLogger(__name__)
router = APIRouter()

STAGE_META: dict[str, tuple[float, str]] = {
    "queued": (0.0, "Queued"),
    "planner": (0.05, "Planning"),
    "search": (0.15, "Searching"),
    "retrieval": (0.35, "Fetching full text"),
    "quality_filter": (0.50, "Quality filter"),
    "extraction": (0.70, "Extracting fields"),
    "extraction_sub_agents": (0.75, "Sub-agent extraction"),
    "extraction_merge": (0.80, "Merge extraction"),
    "reviewer": (0.90, "Review"),
    "reviewer_retry": (0.95, "Reviewer retry"),
    "done": (1.00, "Done"),
    "error": (1.00, "Error"),
}

_TASK_EXPIRE_SECONDS = 1800
_TERMINAL_STATES = {"done", "error", "cancelled"}


class CancelledByUser(Exception):
    """Raised when the task is cancelled by the user."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PipelineTask:
    task_id: str = ""
    kind: str = "search"
    title: str = ""
    task: asyncio.Task | None = None
    runner: Callable[[], Awaitable[None]] | None = field(default=None, repr=False)
    ws_connections: set[WebSocket] = field(default_factory=set)
    messages: list[dict] = field(default_factory=list)
    result: list[dict] | None = None
    error: str | None = None
    cancelled: bool = False
    created_at: float = field(default_factory=time.monotonic)
    created_at_iso: str = field(default_factory=_now_iso)
    updated_at: float = field(default_factory=time.monotonic)
    updated_at_iso: str = field(default_factory=_now_iso)
    started_at: float | None = None
    started_at_iso: str | None = None
    state: str = "queued"
    current_stage: str = "queued"
    progress: float = 0.0
    detail: str = "Waiting to enter queue"
    activity_text: str = ""
    stage_data: dict[str, int] = field(default_factory=dict)
    queue_position: int | None = None
    finished_at: float | None = None


_pipeline_tasks: dict[str, PipelineTask] = {}
_queued_task_ids: list[str] = []
_queue_lock = asyncio.Lock()


def _is_terminal_state(state: str) -> bool:
    return state in _TERMINAL_STATES


def _count_running_tasks() -> int:
    return sum(1 for entry in _pipeline_tasks.values() if entry.state == "running")


def _format_queue_detail(queue_position: int) -> str:
    ahead = max(queue_position - 1, 0)
    return f"Queued at position {queue_position}. {ahead} task(s) ahead."


def _build_queued_msg(queue_position: int) -> dict[str, Any]:
    return {
        "type": "stage",
        "stage": "queued",
        "progress": 0.0,
        "label": STAGE_META["queued"][1],
        "detail": _format_queue_detail(queue_position),
        "state": "queued",
        "queue_position": queue_position,
    }


def _build_running_msg(started_at: str) -> dict[str, Any]:
    return {
        "type": "stage",
        "progress": 0.0,
        "label": "Task started",
        "detail": "Task started",
        "state": "running",
        "queue_position": None,
        "started_at": started_at,
    }


def _build_cancelled_msg() -> dict[str, Any]:
    return {
        "type": "stage",
        "stage": "error",
        "progress": 1.0,
        "label": "Cancelled",
        "detail": "Task cancelled",
        "state": "cancelled",
        "queue_position": None,
    }


def _build_error_msg(detail: str) -> dict[str, Any]:
    return {
        "type": "stage",
        "stage": "error",
        "progress": 1.0,
        "label": "Error",
        "detail": detail,
        "state": "error",
        "queue_position": None,
    }


def _build_task_summary(task_id: str, entry: PipelineTask) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "kind": entry.kind,
        "title": entry.title,
        "state": entry.state,
        "current_stage": entry.current_stage,
        "progress": round(entry.progress, 4),
        "detail": entry.detail,
        "created_at": entry.created_at_iso,
        "updated_at": entry.updated_at_iso,
        "started_at": entry.started_at_iso,
        "result_count": len(entry.result) if entry.result is not None else None,
        "cancelled": entry.cancelled,
        "activity_text": entry.activity_text,
        "papers_found": entry.stage_data.get("papers_found"),
        "papers_passed": entry.stage_data.get("papers_passed"),
        "rows_extracted": entry.stage_data.get("rows_extracted"),
        "retrieval_attempted": entry.stage_data.get("retrieval_attempted"),
        "retrieval_total": entry.stage_data.get("retrieval_total"),
        "retrieval_fulltext_success": entry.stage_data.get("retrieval_fulltext_success"),
        "retrieval_fallback_only": entry.stage_data.get("retrieval_fallback_only"),
        "retrieval_failed": entry.stage_data.get("retrieval_failed"),
        "queue_position": entry.queue_position,
    }


def _extract_search_metadata(entry: PipelineTask) -> dict[str, Any]:
    for message in reversed(entry.messages):
        if message.get("type") != "stage":
            continue
        stats = message.get("search_stats")
        if isinstance(stats, dict):
            return {
                "raw_hit_count": int(stats.get("raw_count") or 0),
                "deduped_count": int(stats.get("deduped_count") or 0),
                "returned_count": int(stats.get("returned_count") or 0),
                "db_counts": stats.get("db_counts") or {},
                "blacklist_skipped": int(stats.get("blacklist_skipped") or 0),
                "history_skipped": int(stats.get("history_skipped") or 0),
                "target_passed_count": stats.get("target_passed_count"),
                "final_passed_count": int(stats.get("final_passed_count") or 0),
                "rounds_completed": int(stats.get("rounds_completed") or 0),
                "exhausted_sources": list(stats.get("exhausted_sources") or []),
                "stop_reason": stats.get("stop_reason"),
            }
    return {}


def _purge_expired_tasks() -> int:
    now = time.monotonic()
    expired = [
        task_id
        for task_id, entry in _pipeline_tasks.items()
        if entry.finished_at is not None
        and (now - entry.finished_at) > _TASK_EXPIRE_SECONDS
        and not entry.ws_connections
    ]
    if not expired:
        return 0

    expired_set = set(expired)
    global _queued_task_ids
    _queued_task_ids = [task_id for task_id in _queued_task_ids if task_id not in expired_set]
    for task_id in expired:
        del _pipeline_tasks[task_id]
    logger.info("Purged %d expired pipeline tasks", len(expired))
    return len(expired)


def list_live_tasks() -> list[dict[str, Any]]:
    _purge_expired_tasks()

    def _sort_key(item: tuple[str, PipelineTask]) -> tuple[int, int, float]:
        _, entry = item
        if entry.state == "running":
            return (0, 0, -entry.updated_at)
        if entry.state == "queued":
            return (1, entry.queue_position or 0, -entry.updated_at)
        return (2, 0, -entry.updated_at)

    items = sorted(_pipeline_tasks.items(), key=_sort_key)
    return [_build_task_summary(task_id, entry) for task_id, entry in items]


def _build_stage_msg(stage: str, ctx: PipelineContext | None = None, detail: str | None = None) -> dict[str, Any]:
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
        retrieval_stats = getattr(ctx, "retrieval_stats", None) or {}
        for key in ("attempted", "total", "fulltext_success", "fallback_only", "failed"):
            if retrieval_stats.get(key) is not None:
                msg[f"retrieval_{key}"] = int(retrieval_stats[key])
        if getattr(ctx, "_search_stats", None):
            msg["search_stats"] = ctx._search_stats
        if getattr(ctx, "round_number", 0):
            msg["round_number"] = ctx.round_number
        if getattr(ctx, "target_passed_count", None) is not None:
            msg["passed_count"] = ctx.passed_count
            msg["target_passed_count"] = ctx.target_passed_count
        if getattr(ctx, "stop_reason", None):
            msg["stop_reason"] = ctx.stop_reason
        if getattr(ctx, "retry_count", 0):
            msg["retry_count"] = ctx.retry_count
    if detail:
        msg["detail"] = detail
    return msg


def _build_progress_msg(stage: str, progress: float, detail: str) -> dict[str, Any]:
    _, label = STAGE_META.get(stage, (progress, stage))
    return {
        "type": "stage",
        "stage": stage,
        "progress": round(progress, 4),
        "label": label,
        "detail": detail,
    }


async def _broadcast(task_id: str, msg: dict[str, Any], *, ephemeral: bool = False) -> None:
    entry = _pipeline_tasks.get(task_id)
    if entry is None:
        return

    entry.updated_at = time.monotonic()
    entry.updated_at_iso = _now_iso()
    msg_type = msg.get("type")

    if "queue_position" in msg:
        queue_position = msg.get("queue_position")
        entry.queue_position = int(queue_position) if queue_position is not None else None

    if "started_at" in msg:
        started_at = msg.get("started_at")
        entry.started_at_iso = str(started_at) if started_at else None

    if msg_type == "activity":
        entry.activity_text = str(msg.get("text") or "")
    elif msg_type == "stage":
        stage = str(msg.get("stage") or "")
        if stage:
            entry.current_stage = stage
        if msg.get("progress") is not None:
            entry.progress = float(msg["progress"])
        detail = str(msg.get("detail") or msg.get("label") or "")
        if detail:
            entry.detail = detail
        stage_data = {
            key: int(msg[key])
            for key in (
                "papers_found",
                "papers_passed",
                "rows_extracted",
                "retrieval_attempted",
                "retrieval_total",
                "retrieval_fulltext_success",
                "retrieval_fallback_only",
                "retrieval_failed",
            )
            if msg.get(key) is not None
        }
        if stage_data:
            entry.stage_data = {**entry.stage_data, **stage_data}

        explicit_state = msg.get("state")
        if explicit_state:
            entry.state = str(explicit_state)
        elif stage == "queued":
            entry.state = "queued"
        elif stage == "done":
            entry.state = "done"
        elif stage == "error":
            entry.state = "cancelled" if entry.cancelled else "error"
        else:
            entry.state = "running"

        if entry.state in _TERMINAL_STATES:
            entry.activity_text = ""
        if entry.state != "queued" and "queue_position" not in msg:
            entry.queue_position = None

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


async def _refresh_queue_state_locked() -> None:
    global _queued_task_ids

    normalized: list[str] = []
    for task_id in _queued_task_ids:
        entry = _pipeline_tasks.get(task_id)
        if entry is None or entry.state != "queued" or entry.cancelled:
            continue
        normalized.append(task_id)
    _queued_task_ids = normalized

    running_offset = 1 if _count_running_tasks() > 0 else 0
    for index, task_id in enumerate(_queued_task_ids):
        entry = _pipeline_tasks[task_id]
        queue_position = running_offset + index + 1
        detail = _format_queue_detail(queue_position)
        if (
            entry.state != "queued"
            or entry.current_stage != "queued"
            or entry.queue_position != queue_position
            or entry.detail != detail
        ):
            await _broadcast(task_id, _build_queued_msg(queue_position))


async def _run_task_wrapper(task_id: str) -> None:
    entry = _pipeline_tasks.get(task_id)
    if entry is None or entry.runner is None:
        return

    try:
        await entry.runner()
        if entry.state == "running":
            entry.error = entry.error or "Task exited without a terminal state"
            await _broadcast(task_id, _build_error_msg(entry.error))
    except Exception as exc:
        if entry.error is None:
            entry.error = str(exc)
        logger.exception("Unhandled task wrapper failure: %s", task_id)
        if not _is_terminal_state(entry.state):
            await _broadcast(task_id, _build_error_msg(entry.error or str(exc)))
    finally:
        if _is_terminal_state(entry.state):
            entry.finished_at = time.monotonic()
        entry.task = None
        async with _queue_lock:
            await _start_next_queued_task_locked()


async def _start_task_locked(entry: PipelineTask) -> None:
    entry.state = "running"
    entry.current_stage = ""
    entry.progress = 0.0
    entry.queue_position = None
    entry.started_at = time.monotonic()
    entry.started_at_iso = _now_iso()
    entry.finished_at = None
    entry.detail = "Task started"
    entry.activity_text = ""
    entry.task = asyncio.get_running_loop().create_task(_run_task_wrapper(entry.task_id))
    await _broadcast(entry.task_id, _build_running_msg(entry.started_at_iso))


async def _start_next_queued_task_locked() -> None:
    if _count_running_tasks() > 0:
        await _refresh_queue_state_locked()
        return

    next_entry: PipelineTask | None = None
    while _queued_task_ids:
        task_id = _queued_task_ids.pop(0)
        entry = _pipeline_tasks.get(task_id)
        if entry is None or entry.state != "queued" or entry.cancelled:
            continue
        next_entry = entry
        break

    if next_entry is not None:
        await _start_task_locked(next_entry)

    await _refresh_queue_state_locked()


async def _enqueue_task(entry: PipelineTask) -> PipelineTask:
    _purge_expired_tasks()
    _pipeline_tasks[entry.task_id] = entry
    async with _queue_lock:
        _queued_task_ids.append(entry.task_id)
        await _start_next_queued_task_locked()
    return entry


async def _cancel_task_locked(task_id: str) -> tuple[bool, str | None]:
    global _queued_task_ids

    entry = _pipeline_tasks.get(task_id)
    if entry is None:
        return False, "task not found"
    if _is_terminal_state(entry.state):
        return False, "task already finished"

    if entry.state == "queued":
        _queued_task_ids = [queued_id for queued_id in _queued_task_ids if queued_id != task_id]
        entry.cancelled = True
        entry.error = "User cancelled"
        entry.finished_at = time.monotonic()
        await _broadcast(task_id, _build_cancelled_msg())
        await _refresh_queue_state_locked()
        return True, None

    if entry.task is None:
        return False, "task is not cancelable"

    entry.cancelled = True
    entry.error = "User cancelled"
    await _broadcast(task_id, {"type": "activity", "text": "Cancelling task..."}, ephemeral=True)
    entry.task.cancel()
    return True, None


async def cancel_task(task_id: str) -> bool:
    async with _queue_lock:
        cancelled, _ = await _cancel_task_locked(task_id)
        return cancelled


async def cancel_task_batch(task_ids: list[str]) -> dict[str, Any]:
    affected_task_ids: list[str] = []
    skipped: list[dict[str, str]] = []

    async with _queue_lock:
        for task_id in task_ids:
            cancelled, reason = await _cancel_task_locked(task_id)
            if cancelled:
                affected_task_ids.append(task_id)
            else:
                skipped.append({"task_id": task_id, "reason": reason or "cancel failed"})

    return {
        "requested": len(task_ids),
        "affected_task_ids": affected_task_ids,
        "skipped": skipped,
    }


async def remove_task_batch(task_ids: list[str]) -> dict[str, Any]:
    affected_task_ids: list[str] = []
    skipped: list[dict[str, str]] = []

    async with _queue_lock:
        for task_id in task_ids:
            entry = _pipeline_tasks.get(task_id)
            if entry is None:
                skipped.append({"task_id": task_id, "reason": "task not found"})
                continue
            if not _is_terminal_state(entry.state):
                skipped.append({"task_id": task_id, "reason": "task is not finished"})
                continue
            del _pipeline_tasks[task_id]
            affected_task_ids.append(task_id)

    return {
        "requested": len(task_ids),
        "affected_task_ids": affected_task_ids,
        "skipped": skipped,
    }


def get_task(task_id: str) -> PipelineTask | None:
    _purge_expired_tasks()
    return _pipeline_tasks.get(task_id)


async def _run_pipeline_task(
    task_id: str,
    query: str,
    limit: int | None,
    target_passed_count: int | None,
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
        pending_broadcasts: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def check_cancel() -> None:
            if entry.cancelled:
                raise CancelledByUser()

        def on_stage(stage: str, ctx: PipelineContext) -> None:
            check_cancel()
            logger.info(
                "Pipeline %s stage=%s papers_found=%d passed=%d rows=%d reviewed=%d",
                task_id,
                stage,
                len(ctx.papers),
                len(ctx.passed_papers),
                len(ctx.rows),
                len(ctx.reviewed_rows),
            )
            pending_broadcasts.append(loop.create_task(_broadcast(task_id, _build_stage_msg(stage, ctx))))

        def on_activity(text: str) -> None:
            check_cancel()
            loop.create_task(_broadcast(task_id, {"type": "activity", "text": text}, ephemeral=True))

        rows = await run_pipeline(
            query=query,
            limit=limit,
            target_passed_count=target_passed_count,
            databases=databases,
            fetch_concurrency=fetch_concurrency,
            llm_concurrency=llm_concurrency,
            use_planner=use_planner,
            on_stage=on_stage,
            on_activity=on_activity,
            max_retries=max_retries,
            mode=mode,
            resume=resume,
            cancel_check=check_cancel,
        )
        check_cancel()

        from lit_researcher.blacklist import add_to_blacklist
        from lit_researcher.output import filter_empty_rows

        kept, discarded = filter_empty_rows(rows)
        failed_dois = [
            row.get("source_doi")
            for row in discarded
            if row.get("source_doi") and row.get("text_source") == "none"
        ]
        if failed_dois:
            add_to_blacklist(failed_dois)

        entry.result = kept
        save_task(
            query,
            kept,
            databases=databases,
            search_metadata=_extract_search_metadata(entry),
        )
        if pending_broadcasts:
            await asyncio.gather(*pending_broadcasts, return_exceptions=True)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"Total {len(kept)} result(s)"))
    except (asyncio.CancelledError, CancelledByUser):
        entry.cancelled = True
        if not entry.error:
            entry.error = "User cancelled"
        await _broadcast(task_id, _build_cancelled_msg())
    except Exception as exc:
        entry.error = str(exc)
        logger.exception("Pipeline task failed: %s", task_id)
        await _broadcast(task_id, _build_error_msg(str(exc)))


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

        await _broadcast(task_id, _build_stage_msg("retrieval", detail=f"Preparing {len(papers)} DOI paper(s)"))
        papers = await fetch_all(papers, max_concurrent=fetch_concurrency)

        await _broadcast(task_id, _build_stage_msg("extraction", detail="Starting DOI extraction"))
        rows = await extract_batch(papers, max_concurrent=llm_concurrency)

        from lit_researcher.agents.reviewer import ReviewerAgent
        from lit_researcher.blacklist import add_to_blacklist
        from lit_researcher.output import filter_empty_rows
        from lit_researcher.pubchem import batch_lookup, enrich_row
        from lit_researcher.extract import _compute_data_quality

        drug_names: set[str] = set()
        for row in rows:
            name = str(row.get("drug_name") or "").strip()
            if name:
                drug_names.add(name)

        if drug_names:
            await _broadcast(
                task_id,
                {"type": "activity", "text": f"PubChem lookup for {len(drug_names)} drug(s)..."},
                ephemeral=True,
            )
            pc_cache, _stats = await batch_lookup(drug_names)
            for row in rows:
                name = str(row.get("drug_name") or "").strip()
                if name and name in pc_cache and pc_cache[name]:
                    filled = enrich_row(row, pc_cache[name])
                    if filled:
                        row["_data_quality"] = _compute_data_quality(row)

        review_ctx = PipelineContext(
            query=f"DOI import ({len(dois)} papers)",
            limit=len(dois),
            databases=[],
            fetch_concurrency=fetch_concurrency or 15,
            llm_concurrency=llm_concurrency or 5,
            mode=mode,
        )
        review_ctx.rows = rows
        await _broadcast(task_id, _build_stage_msg("reviewer", detail="Reviewing DOI results"))
        review_ctx = await ReviewerAgent().run_timed(review_ctx)
        reviewed = review_ctx.reviewed_rows if review_ctx.reviewed_rows else rows

        kept, discarded = filter_empty_rows(reviewed)
        failed_dois = [
            row.get("source_doi")
            for row in discarded
            if row.get("source_doi") and row.get("text_source") == "none"
        ]
        if failed_dois:
            add_to_blacklist(failed_dois)

        entry.result = kept
        save_task(f"DOI import ({len(dois)} papers)", kept)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"Total {len(kept)} result(s)"))
    except asyncio.CancelledError:
        entry.cancelled = True
        if not entry.error:
            entry.error = "User cancelled"
        await _broadcast(task_id, _build_cancelled_msg())
    except Exception as exc:
        entry.error = str(exc)
        logger.exception("DOI task failed: %s", task_id)
        await _broadcast(task_id, _build_error_msg(str(exc)))


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
        def check_cancel() -> None:
            if entry.cancelled:
                raise CancelledByUser()

        total_files = len(files)
        await _broadcast(
            task_id,
            _build_progress_msg("retrieval", 0.05, f"Parsing {total_files} local PDF file(s)"),
        )

        def on_pdf_progress(done: int, total: int, paper: dict[str, Any]) -> None:
            check_cancel()
            progress = 0.05 + (done / max(total, 1)) * 0.25
            title = str(paper.get("title") or paper.get("file_name") or "Untitled PDF")
            status = "done" if not paper.get("parse_error") else "failed"
            asyncio.get_running_loop().create_task(
                _broadcast(
                    task_id,
                    _build_progress_msg(
                        "retrieval",
                        progress,
                        f"PDF parse [{done}/{total}] {status}: {title[:60]}",
                    ),
                )
            )

        papers = await extract_uploaded_pdfs(
            files,
            on_progress=on_pdf_progress,
            cancel_check=check_cancel,
        )
        check_cancel()

        ctx = PipelineContext(
            query=f"PDF import ({total_files} files)",
            limit=total_files,
            databases=[],
            fetch_concurrency=2,
            llm_concurrency=llm_concurrency or 5,
            mode=mode,
        )
        ctx._cancel_check = check_cancel
        ctx.papers = papers
        ctx.papers_with_text = papers
        await _broadcast(task_id, _build_stage_msg("retrieval", ctx, detail=f"Parsed {len(papers)} PDF(s)"))

        from lit_researcher.agents.quality_filter import QualityFilterAgent
        from lit_researcher.agents.reviewer import ReviewerAgent

        ctx = await QualityFilterAgent().run_timed(ctx)
        await _broadcast(task_id, _build_stage_msg("quality_filter", ctx, detail="Quality filter complete"))
        check_cancel()

        async def on_extract_complete(done: int, total: int, row: dict[str, Any]) -> None:
            check_cancel()
            await _broadcast(
                task_id,
                {
                    "type": "activity",
                    "text": f"Extract [{done}/{total}] {str(row.get('source_title') or 'Untitled PDF')[:60]}",
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
            str(paper.get("paper_id", "")): paper.get("_quality_scores", {}) or {}
            for paper in ctx.passed_papers
        }
        for row in rows:
            scores = quality_by_paper_id.get(str(row.get("paper_id", "")), {})
            row["_quality_label"] = scores.get("quality_label", "medium_value")
            row["_quality_total"] = scores.get("total_score", 0.0)

        ctx.rows = rows
        await _broadcast(task_id, _build_stage_msg("extraction", ctx, detail="Extraction complete"))
        check_cancel()

        if ctx.rows:
            ctx = await ReviewerAgent().run_timed(ctx)
            await _broadcast(task_id, _build_stage_msg("reviewer", ctx, detail="Review complete"))
        check_cancel()

        reviewed_by_paper_id = {
            str(row.get("paper_id", "")): row
            for row in (ctx.reviewed_rows if ctx.reviewed_rows else ctx.rows)
        }

        result_rows: list[dict[str, Any]] = []
        failed_paper_ids = {str(paper.get("paper_id", "")) for paper in ctx.failed_papers}
        for paper in papers:
            check_cancel()
            paper_id = str(paper.get("paper_id", ""))
            if paper_id in reviewed_by_paper_id:
                result_rows.append(reviewed_by_paper_id[paper_id])
                continue
            if paper.get("parse_error"):
                result_rows.append(_build_pdf_skip_row(paper, str(paper["parse_error"])))
                continue
            if paper_id in failed_paper_ids:
                result_rows.append(_build_pdf_skip_row(paper, "Failed quality filter"))
                continue
            result_rows.append(_build_pdf_skip_row(paper, "No extraction result"))

        entry.result = result_rows
        save_task(f"PDF import ({total_files} files)", result_rows)
        await _broadcast(task_id, _build_stage_msg("done", detail=f"Total {len(result_rows)} result(s)"))
    except (asyncio.CancelledError, CancelledByUser):
        entry.cancelled = True
        if not entry.error:
            entry.error = "User cancelled"
        await _broadcast(task_id, _build_cancelled_msg())
    except Exception as exc:
        entry.error = str(exc)
        logger.exception("PDF task failed: %s", task_id)
        await _broadcast(task_id, _build_error_msg(str(exc)))


async def start_pipeline_task(
    query: str,
    limit: int | None = None,
    target_passed_count: int | None = None,
    databases: list[str] | None = None,
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
    use_planner: bool = True,
    max_retries: int = 1,
    mode: str = "multi",
    resume: bool = False,
) -> PipelineTask:
    task_id = uuid.uuid4().hex

    async def runner() -> None:
        await _run_pipeline_task(
            task_id,
            query,
            limit,
            target_passed_count,
            databases,
            fetch_concurrency,
            llm_concurrency,
            use_planner,
            max_retries,
            mode,
            resume,
        )

    entry = PipelineTask(task_id=task_id, kind="search", title=query, runner=runner)
    return await _enqueue_task(entry)


async def start_doi_task(
    dois: list[str],
    mode: str = "multi",
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
) -> PipelineTask:
    task_id = uuid.uuid4().hex

    async def runner() -> None:
        await _run_doi_task(task_id, dois, mode, fetch_concurrency, llm_concurrency)

    entry = PipelineTask(
        task_id=task_id,
        kind="doi",
        title=f"DOI import ({len(dois)} papers)",
        runner=runner,
    )
    return await _enqueue_task(entry)


async def start_pdf_task(
    files: list[tuple[str, bytes]],
    mode: str = "multi",
    llm_concurrency: int | None = None,
) -> PipelineTask:
    task_id = uuid.uuid4().hex

    async def runner() -> None:
        await _run_pdf_task(task_id, files, mode, llm_concurrency)

    entry = PipelineTask(
        task_id=task_id,
        kind="pdf",
        title=f"PDF import ({len(files)} files)",
        runner=runner,
    )
    return await _enqueue_task(entry)


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
