from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from api.ws.pipeline import start_pipeline_task, start_doi_task, start_pdf_task, get_task, cancel_task
from lit_researcher.pdf_import import list_server_pdfs, load_server_pdf_inputs

router = APIRouter()


class PipelineRunRequest(BaseModel):
    query: str
    limit: int | None = None
    databases: list[str] | None = None
    fetch_concurrency: int | None = None
    llm_concurrency: int | None = None
    use_planner: bool = True
    max_retries: int = 1
    mode: str = "multi"
    resume: bool = False


class PipelineRunResponse(BaseModel):
    task_id: str


class DOIImportRequest(BaseModel):
    dois: list[str]
    mode: str = "multi"
    fetch_concurrency: int | None = None
    llm_concurrency: int | None = None


class ServerPdfEntryResponse(BaseModel):
    path: str
    name: str
    size: int
    modified_at: str


class ServerPdfImportRequest(BaseModel):
    paths: list[str]
    mode: str = "multi"
    llm_concurrency: int | None = None


class TaskStatusResponse(BaseModel):
    task_id: str
    done: bool
    error: str | None = None
    result_count: int | None = None
    messages: list[dict] = Field(default_factory=list)


@router.get("/server-pdfs", response_model=list[ServerPdfEntryResponse])
async def pipeline_server_pdfs():
    return [
        ServerPdfEntryResponse(
            path=entry.path,
            name=entry.name,
            size=entry.size,
            modified_at=entry.modified_at,
        )
        for entry in list_server_pdfs()
    ]


@router.post("/run", response_model=PipelineRunResponse)
async def pipeline_run(req: PipelineRunRequest):
    try:
        task_id = start_pipeline_task(
            query=req.query,
            limit=req.limit,
            databases=req.databases,
            fetch_concurrency=req.fetch_concurrency,
            llm_concurrency=req.llm_concurrency,
            use_planner=req.use_planner,
            max_retries=req.max_retries,
            mode=req.mode,
            resume=req.resume,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return PipelineRunResponse(task_id=task_id)


@router.post("/doi", response_model=PipelineRunResponse)
async def pipeline_doi(req: DOIImportRequest):
    if not req.dois:
        raise HTTPException(status_code=400, detail="dois list is empty")
    try:
        task_id = start_doi_task(
            dois=req.dois,
            mode=req.mode,
            fetch_concurrency=req.fetch_concurrency,
            llm_concurrency=req.llm_concurrency,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return PipelineRunResponse(task_id=task_id)


@router.post("/pdf", response_model=PipelineRunResponse)
async def pipeline_pdf(
    files: list[UploadFile] = File(...),
    mode: str = Form("multi"),
    llm_concurrency: int | None = Form(None),
):
    if not files:
        raise HTTPException(status_code=400, detail="no files uploaded")

    uploaded_files: list[tuple[str, bytes]] = []
    for file in files:
        file_name = file.filename or "document.pdf"
        if not file_name.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"{file_name} 不是 PDF 文件")
        uploaded_files.append((file_name, await file.read()))

    try:
        task_id = start_pdf_task(
            files=uploaded_files,
            mode=mode,
            llm_concurrency=llm_concurrency,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return PipelineRunResponse(task_id=task_id)


@router.post("/pdf-server", response_model=PipelineRunResponse)
async def pipeline_pdf_server(req: ServerPdfImportRequest):
    if not req.paths:
        raise HTTPException(status_code=400, detail="no server pdfs selected")

    try:
        server_files = load_server_pdf_inputs(req.paths)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"server pdf not found: {exc.args[0]}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to read server pdf: {exc}") from exc

    try:
        task_id = start_pdf_task(
            files=server_files,
            mode=req.mode,
            llm_concurrency=req.llm_concurrency,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return PipelineRunResponse(task_id=task_id)


@router.get("/status/{task_id}", response_model=TaskStatusResponse)
async def pipeline_status(task_id: str):
    entry = get_task(task_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="task not found")
    done = entry.task is not None and entry.task.done()
    return TaskStatusResponse(
        task_id=task_id,
        done=done,
        error=entry.error,
        result_count=len(entry.result) if entry.result is not None else None,
        messages=entry.messages,
    )


@router.post("/cancel/{task_id}")
async def pipeline_cancel(task_id: str):
    if not cancel_task(task_id):
        raise HTTPException(status_code=404, detail="task not found or already finished")
    return {"task_id": task_id, "cancelled": True}


@router.get("/result/{task_id}")
async def pipeline_result(task_id: str):
    entry = get_task(task_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="task not found")
    if entry.result is None:
        raise HTTPException(status_code=409, detail="task not finished or failed")
    return {"task_id": task_id, "rows": entry.result}
