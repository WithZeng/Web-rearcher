from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

import lit_researcher.config as config
from lit_researcher.ui_helpers import (
    apply_model,
    import_env_text,
    save_to_env,
    test_model_connection,
)

router = APIRouter()


class ConfigResponse(BaseModel):
    model: str
    base_url: str
    api_type: str
    has_api_key: bool
    max_results: int
    fetch_concurrency: int
    llm_concurrency: int
    has_notion: bool
    notion_parent_page_id: str
    notion_db_name: str
    unpaywall_email: str
    http_proxy: str
    ieee_api_key: str
    scopus_api_key: str
    grobid_url: str
    all_databases: list[str]
    default_databases: list[str]


class ConfigUpdateRequest(BaseModel):
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_type: str | None = None
    notion_token: str | None = None
    notion_parent_page_id: str | None = None
    notion_db_name: str | None = None
    unpaywall_email: str | None = None
    http_proxy: str | None = None
    ieee_api_key: str | None = None
    scopus_api_key: str | None = None
    grobid_url: str | None = None


class TestConnectionRequest(BaseModel):
    api_key: str = ""
    base_url: str = ""
    model: str = "gpt-4o-mini"
    api_type: str = "openai"


class TestConnectionResponse(BaseModel):
    success: bool
    message: str


class EnvImportResponse(BaseModel):
    ok: bool
    imported: list[str]
    ignored: list[str]
    warnings: list[str]


@router.get("/")
async def get_config():
    return ConfigResponse(
        model=config.OPENAI_MODEL,
        base_url=config.OPENAI_BASE_URL,
        api_type=config.API_TYPE,
        has_api_key=bool(config.OPENAI_API_KEY),
        max_results=config.MAX_RESULTS,
        fetch_concurrency=config.FETCH_CONCURRENCY,
        llm_concurrency=config.LLM_CONCURRENCY,
        has_notion=bool(config.NOTION_TOKEN),
        notion_parent_page_id=config.NOTION_PARENT_PAGE_ID,
        notion_db_name=config.NOTION_DB_NAME,
        unpaywall_email=config.UNPAYWALL_EMAIL,
        http_proxy=config.HTTP_PROXY,
        ieee_api_key=config.IEEE_API_KEY,
        scopus_api_key=config.SCOPUS_API_KEY,
        grobid_url=config.GROBID_URL,
        all_databases=config.ALL_DATABASES,
        default_databases=config.DEFAULT_DATABASES,
    )


@router.put("/")
async def update_config(req: ConfigUpdateRequest):
    effective_type = req.api_type or ""
    if req.api_key is not None:
        apply_model(
            api_key=req.api_key,
            base_url=req.base_url or config.OPENAI_BASE_URL,
            model_name=req.model or config.OPENAI_MODEL,
            api_type=effective_type,
        )
    else:
        if req.base_url is not None:
            apply_model(config.OPENAI_API_KEY, req.base_url, config.OPENAI_MODEL, api_type=effective_type)
        if req.model is not None:
            apply_model(config.OPENAI_API_KEY, config.OPENAI_BASE_URL, req.model, api_type=effective_type)
    if req.api_type is not None and req.api_key is None and req.base_url is None and req.model is None:
        save_to_env("API_TYPE", req.api_type)
        config.API_TYPE = req.api_type

    if req.notion_token is not None:
        save_to_env("NOTION_TOKEN", req.notion_token)
        config.NOTION_TOKEN = req.notion_token
    if req.notion_parent_page_id is not None:
        save_to_env("NOTION_PARENT_PAGE_ID", req.notion_parent_page_id)
        config.NOTION_PARENT_PAGE_ID = req.notion_parent_page_id
    if req.notion_db_name is not None:
        save_to_env("NOTION_DB_NAME", req.notion_db_name)
        config.NOTION_DB_NAME = req.notion_db_name
    if req.unpaywall_email is not None:
        save_to_env("UNPAYWALL_EMAIL", req.unpaywall_email)
        config.UNPAYWALL_EMAIL = req.unpaywall_email
    if req.http_proxy is not None:
        save_to_env("HTTP_PROXY", req.http_proxy)
        config.HTTP_PROXY = req.http_proxy
    if req.ieee_api_key is not None:
        save_to_env("IEEE_API_KEY", req.ieee_api_key)
        config.IEEE_API_KEY = req.ieee_api_key
    if req.scopus_api_key is not None:
        save_to_env("SCOPUS_API_KEY", req.scopus_api_key)
        config.SCOPUS_API_KEY = req.scopus_api_key
    if req.grobid_url is not None:
        save_to_env("GROBID_URL", req.grobid_url)
        config.GROBID_URL = req.grobid_url

    return {"ok": True}


@router.post("/test", response_model=TestConnectionResponse)
async def test_connection(req: TestConnectionRequest):
    ok, message = test_model_connection(
        req.api_key or config.OPENAI_API_KEY,
        req.base_url or config.OPENAI_BASE_URL,
        req.model or config.OPENAI_MODEL,
        api_type=req.api_type,
    )
    return TestConnectionResponse(success=ok, message=message)


@router.post("/test-notion", response_model=TestConnectionResponse)
async def test_notion():
    from lit_researcher.notion_writer import test_notion_connection
    ok, message = test_notion_connection()
    return TestConnectionResponse(success=ok, message=message)


@router.post("/import-env", response_model=EnvImportResponse)
async def import_env(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="请上传 .env 配置文件")
    if not file.filename.lower().endswith((".env", ".txt")):
        raise HTTPException(status_code=400, detail="仅支持上传 .env 或 .txt 文件")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    try:
        env_text = content.decode("utf-8")
    except UnicodeDecodeError:
        try:
            env_text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=400, detail="文件编码不支持，请使用 UTF-8") from exc

    result = import_env_text(env_text)
    return EnvImportResponse(ok=True, **result)
