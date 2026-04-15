from __future__ import annotations

import logging
import signal
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import pipeline, history, export, config_routes, models, notion
from api.ws.pipeline import router as ws_router, _count_running_tasks
from lit_researcher.blacklist import blacklist_count, clear_blacklist
from lit_researcher.config import ALL_DATABASES, DEFAULT_DATABASES, FIELDS
from lit_researcher.output import ALL_COLUMNS, ALL_CN
from lit_researcher.ui_helpers import FIELD_LABELS, RECOMMENDED_QUERIES

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Literature Researcher API 启动完毕")
    yield
    logger.info("Literature Researcher API 正在关闭...")


app = FastAPI(title="Literature Researcher API", lifespan=lifespan)
_START_TIME = time.monotonic()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pipeline.router, prefix="/api/pipeline", tags=["pipeline"])
app.include_router(history.router, prefix="/api/history", tags=["history"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(config_routes.router, prefix="/api/config", tags=["config"])
app.include_router(models.router, prefix="/api/models", tags=["models"])
app.include_router(notion.router, prefix="/api/notion", tags=["notion"])
app.include_router(ws_router)


@app.get("/api/blacklist/count")
async def get_blacklist_count():
    return {"count": blacklist_count()}


@app.delete("/api/blacklist")
async def delete_blacklist():
    removed = clear_blacklist()
    return {"removed": removed}


@app.get("/api/health")
async def health_check():
    uptime = time.monotonic() - _START_TIME
    return {
        "status": "ok",
        "uptime_seconds": round(uptime, 1),
        "running_tasks": _count_running_tasks(),
    }


@app.get("/api/meta")
async def get_meta():
    return {
        "all_databases": ALL_DATABASES,
        "default_databases": DEFAULT_DATABASES,
        "fields": FIELDS,
        "all_columns": ALL_COLUMNS,
        "column_labels_cn": ALL_CN,
        "field_labels": FIELD_LABELS,
        "recommended_queries": RECOMMENDED_QUERIES,
    }
