from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lit_researcher.ui_helpers import (
    load_history,
    delete_task,
    history_stats,
    merge_history_rows,
    cleanup_history,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class HistoryStatsResponse(BaseModel):
    total_tasks: int
    total_papers: int
    avg_quality: float
    source_counts: dict[str, int]


class HistoryTaskResponse(BaseModel):
    query: str
    timestamp: str
    count: int
    rows: list[dict]


@router.get("/", response_model=list[HistoryTaskResponse])
async def list_history():
    return load_history()


@router.get("/stats", response_model=HistoryStatsResponse)
async def get_stats():
    history = load_history()
    return history_stats(history)


@router.get("/merged")
async def get_merged_rows(
    min_quality: float = 0.0,
    remove_empty: bool = True,
    pushed_filter: str = "all",
):
    history = load_history()
    total_raw = sum(len(t.get("rows", [])) for t in history)
    all_rows = merge_history_rows(history, min_quality=0.0, remove_empty=False)
    filtered = merge_history_rows(
        history,
        min_quality=min_quality,
        remove_empty=remove_empty,
        pushed_filter=pushed_filter,
    )
    pushed_count = sum(1 for r in all_rows if r.get("_pushed_to_notion"))
    unpushed_count = len(all_rows) - pushed_count
    return {
        "count": len(filtered),
        "total_before": len(all_rows),
        "removed": len(all_rows) - len(filtered),
        "dedup_discarded": total_raw - len(all_rows),
        "pushed_count": pushed_count,
        "unpushed_count": unpushed_count,
        "rows": filtered,
    }


@router.post("/cleanup")
async def cleanup(min_quality: float = 0.0):
    """Permanently remove invalid/low-quality rows from all history files."""
    result = cleanup_history(min_quality=min_quality)
    return result


@router.post("/enrich-pubchem")
async def enrich_pubchem(force: bool = False):
    """Enrich merged history rows with PubChem drug properties via SSE stream.

    When *force* is True, PubChem authoritative data overwrites existing
    LLM-extracted values.  Default behaviour only fills empty fields.
    """
    progress_q: asyncio.Queue = asyncio.Queue()

    async def _run() -> dict:
        from lit_researcher.pubchem import batch_lookup, enrich_row

        history = load_history()
        all_rows = merge_history_rows(history, min_quality=0.0, remove_empty=False)

        drug_names: set[str] = set()
        for row in all_rows:
            name = str(row.get("drug_name") or "").strip()
            if name:
                drug_names.add(name)

        if not drug_names:
            return {
                "phase": "done",
                "enriched_papers": 0,
                "fields_filled": 0,
                "resolved_drugs": 0,
                "unresolved_drugs": 0,
                "total_rows": len(all_rows),
            }

        await progress_q.put({
            "phase": "lookup",
            "message": f"开始查询 PubChem，共 {len(drug_names)} 种药物…",
            "done": 0,
            "total": len(drug_names),
        })

        def _on_progress(done: int, total: int, name: str) -> None:
            progress_q.put_nowait({
                "phase": "lookup",
                "message": f"查询 {name}",
                "done": done,
                "total": total,
            })

        seen_drugs, pc_stats = await batch_lookup(drug_names, on_progress=_on_progress)

        resolved = {k for k, v in seen_drugs.items() if v}
        unresolved = drug_names - resolved

        await progress_q.put({
            "phase": "enrich",
            "message": f"PubChem 识别 {len(resolved)} 种药物，开始写入数据…",
            "resolved_drugs": len(resolved),
            "unresolved_drugs": len(unresolved),
            "cache_hit": pc_stats.get("cache_hit", 0),
        })

        enriched_count = 0
        fields_filled = 0

        for row in all_rows:
            drug_name = str(row.get("drug_name") or "").strip()
            if not drug_name:
                continue
            pubchem_data = seen_drugs.get(drug_name, {})
            if not pubchem_data:
                continue
            n = enrich_row(row, pubchem_data, force=force)
            if n > 0:
                enriched_count += 1
                fields_filled += n

        if enriched_count:
            from lit_researcher.ui_helpers import _save_enriched_rows
            _save_enriched_rows(all_rows, history)

        return {
            "phase": "done",
            "enriched_papers": enriched_count,
            "fields_filled": fields_filled,
            "resolved_drugs": len(resolved),
            "unresolved_drugs": len(unresolved),
            "total_rows": len(all_rows),
            "cache_hit": pc_stats.get("cache_hit", 0),
        }

    async def event_stream():
        task = asyncio.create_task(_run())
        try:
            while not task.done():
                try:
                    msg = await asyncio.wait_for(progress_q.get(), timeout=1.0)
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'phase': 'heartbeat'})}\n\n"

            while not progress_q.empty():
                msg = progress_q.get_nowait()
                yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"

            result = task.result()
            yield f"data: {json.dumps(result, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logger.exception("PubChem enrichment failed")
            yield f"data: {json.dumps({'phase': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.delete("/{timestamp}")
async def remove_task(timestamp: str):
    history = load_history()
    found = any(t.get("timestamp") == timestamp for t in history)
    if not found:
        raise HTTPException(status_code=404, detail="task not found")
    delete_task(timestamp)
    return {"deleted": timestamp}
