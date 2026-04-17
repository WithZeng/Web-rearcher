from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def clean_pipeline_tasks():
    import api.ws.pipeline as ws_pipeline

    ws_pipeline._pipeline_tasks.clear()
    try:
        yield
    finally:
        ws_pipeline._pipeline_tasks.clear()


def test_broadcast_updates_pipeline_task_summary():
    import api.ws.pipeline as ws_pipeline

    entry = ws_pipeline.PipelineTask(task_id="task-1", kind="search", title="demo query")
    ws_pipeline._pipeline_tasks["task-1"] = entry

    asyncio.run(
        ws_pipeline._broadcast(
            "task-1",
            {
                "type": "stage",
                "stage": "retrieval",
                "progress": 0.35,
                "detail": "fetching papers",
                "papers_found": 12,
                "papers_passed": 5,
            },
        )
    )
    asyncio.run(
        ws_pipeline._broadcast(
            "task-1",
            {"type": "activity", "text": "working"},
            ephemeral=True,
        )
    )
    asyncio.run(
        ws_pipeline._broadcast(
            "task-1",
            {"type": "stage", "stage": "done", "progress": 1.0, "detail": "finished"},
        )
    )

    assert entry.current_stage == "done"
    assert entry.progress == 1.0
    assert entry.state == "done"
    assert entry.detail == "finished"
    assert entry.stage_data["papers_found"] == 12
    assert entry.stage_data["papers_passed"] == 5
    assert entry.activity_text == ""


def test_pipeline_live_lists_recent_tasks():
    import api.routes.pipeline as pipeline_routes
    import api.ws.pipeline as ws_pipeline

    entry = ws_pipeline.PipelineTask(
        task_id="task-live",
        kind="doi",
        title="DOI import (3 papers)",
        current_stage="search",
        progress=0.2,
        detail="queued",
        activity_text="processing",
    )
    ws_pipeline._pipeline_tasks["task-live"] = entry

    result = asyncio.run(pipeline_routes.pipeline_live())

    assert len(result) == 1
    assert result[0].task_id == "task-live"
    assert result[0].kind == "doi"
    assert result[0].title == "DOI import (3 papers)"
    assert result[0].activity_text == "processing"


def test_pipeline_status_includes_task_summary_fields():
    import api.routes.pipeline as pipeline_routes
    import api.ws.pipeline as ws_pipeline

    entry = ws_pipeline.PipelineTask(
        task_id="task-status",
        kind="pdf",
        title="PDF import (2 files)",
        current_stage="extraction",
        progress=0.7,
        detail="extracting",
        activity_text="worker active",
        stage_data={"rows_extracted": 4},
    )
    entry.messages.append({"type": "stage", "stage": "extraction", "progress": 0.7})
    ws_pipeline._pipeline_tasks["task-status"] = entry

    result = asyncio.run(pipeline_routes.pipeline_status("task-status"))

    assert result.task_id == "task-status"
    assert result.kind == "pdf"
    assert result.title == "PDF import (2 files)"
    assert result.current_stage == "extraction"
    assert result.progress == 0.7
    assert result.activity_text == "worker active"
    assert result.rows_extracted == 4
    assert result.messages


def test_pipeline_live_purges_expired_finished_tasks():
    import api.routes.pipeline as pipeline_routes
    import api.ws.pipeline as ws_pipeline

    entry = ws_pipeline.PipelineTask(
        task_id="task-expired",
        kind="search",
        title="expired",
        state="done",
        current_stage="done",
        progress=1.0,
        detail="done",
    )
    entry.finished_at = time.monotonic() - ws_pipeline._TASK_EXPIRE_SECONDS - 1
    ws_pipeline._pipeline_tasks["task-expired"] = entry

    result = asyncio.run(pipeline_routes.pipeline_live())

    assert result == []
    assert ws_pipeline._pipeline_tasks == {}


def test_pipeline_status_raises_404_for_missing_task():
    import api.routes.pipeline as pipeline_routes

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(pipeline_routes.pipeline_status("missing-task"))

    assert excinfo.value.status_code == 404
