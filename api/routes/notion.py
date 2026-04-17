from __future__ import annotations

import asyncio
import json
import queue

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from lit_researcher.notion_writer import smart_push, notion_db_status
from lit_researcher.ui_helpers import mark_rows_pushed

router = APIRouter()


class NotionPushRequest(BaseModel):
    rows: list[dict] = Field(..., min_length=1)
    database_id: str | None = None
    patch_existing: bool = False


class NotionPushResponse(BaseModel):
    pushed: int
    patched: int = 0
    skipped_quality: int
    skipped_duplicate: int
    total: int
    pushed_dois: list[str] = []
    marked_dois: list[str] = []


@router.post("/push")
async def push_to_notion(req: NotionPushRequest):
    """Push rows to Notion with SSE progress streaming."""
    progress_q: queue.Queue[dict | None] = queue.Queue()

    def on_progress(data: dict) -> None:
        progress_q.put(data)

    async def _run() -> dict:
        return await asyncio.to_thread(
            smart_push, req.rows, req.database_id, on_progress, req.patch_existing,
        )

    async def event_stream():
        task = asyncio.create_task(_run())
        try:
            while not task.done():
                try:
                    msg = progress_q.get_nowait()
                    if msg is not None:
                        yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    await asyncio.sleep(0.15)

            # Drain remaining messages
            while not progress_q.empty():
                msg = progress_q.get_nowait()
                if msg is not None:
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"

            stats = task.result()
            marked_dois = stats.get("marked_dois") or stats.get("pushed_dois", [])
            if marked_dois:
                mark_rows_pushed(marked_dois)

            yield f"data: {json.dumps(stats, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'phase': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/status")
async def get_notion_status():
    from lit_researcher.notion_writer import notion_db_status as _status
    return await asyncio.to_thread(_status)
