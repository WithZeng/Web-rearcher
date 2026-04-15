from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from lit_researcher.output import ALL_COLUMNS
from lit_researcher.ui_helpers import (
    df_to_csv_bytes,
    df_to_excel_bytes,
    rows_to_json_bytes,
    rows_to_bibtex_bytes,
)

router = APIRouter()


class ExportRequest(BaseModel):
    rows: list[dict] = Field(..., min_length=1)


@router.post("/csv")
async def export_csv(req: ExportRequest):
    df = pd.DataFrame(req.rows)
    for col in ALL_COLUMNS:
        if col not in df.columns:
            df[col] = None
    df = df[[c for c in ALL_COLUMNS if c in df.columns]]
    data = df_to_csv_bytes(df)
    return Response(
        content=data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=results.csv"},
    )


@router.post("/excel")
async def export_excel(req: ExportRequest):
    data = df_to_excel_bytes(req.rows)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=results.xlsx"},
    )


@router.post("/json")
async def export_json(req: ExportRequest):
    data = rows_to_json_bytes(req.rows)
    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=results.json"},
    )


@router.post("/bibtex")
async def export_bibtex(req: ExportRequest):
    data = rows_to_bibtex_bytes(req.rows)
    return Response(
        content=data,
        media_type="application/x-bibtex",
        headers={"Content-Disposition": "attachment; filename=results.bib"},
    )
