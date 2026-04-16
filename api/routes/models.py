from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import lit_researcher.config as config
from lit_researcher.ui_helpers import load_models, save_models, apply_model

router = APIRouter()


class ModelEntry(BaseModel):
    name: str
    api_key: str = ""
    base_url: str = ""
    model: str = "gpt-4o-mini"
    api_type: str = "openai"


class ModelListResponse(BaseModel):
    models: list[ModelEntry]


def _normalize_model_entry(entry: ModelEntry) -> ModelEntry:
    name = entry.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="model name is required")

    api_key = (entry.api_key or "").strip() or config.OPENAI_API_KEY
    base_url = (entry.base_url or "").strip() or config.OPENAI_BASE_URL
    model_name = (entry.model or "").strip() or config.OPENAI_MODEL or "gpt-4o-mini"
    api_type = (entry.api_type or "").strip() or config.API_TYPE or "openai"

    return ModelEntry(
        name=name,
        api_key=api_key,
        base_url=base_url,
        model=model_name,
        api_type=api_type,
    )


def _resolve_saved_model(data: dict) -> ModelEntry:
    return _normalize_model_entry(ModelEntry(**data))


@router.get("/", response_model=ModelListResponse)
async def list_models():
    return ModelListResponse(models=[ModelEntry(**m) for m in load_models()])


@router.post("/", response_model=ModelEntry)
async def create_model(entry: ModelEntry):
    entry = _normalize_model_entry(entry)
    models = load_models()
    if any(m.get("name") == entry.name for m in models):
        raise HTTPException(status_code=409, detail=f"model '{entry.name}' already exists")
    models.append(entry.model_dump())
    save_models(models)
    return entry


@router.put("/{name}", response_model=ModelEntry)
async def update_model(name: str, entry: ModelEntry):
    target_name = name.strip()
    entry = _normalize_model_entry(entry)
    models = load_models()
    for i, m in enumerate(models):
        if m.get("name") == target_name:
            models[i] = entry.model_dump()
            save_models(models)
            return entry
    raise HTTPException(status_code=404, detail=f"model '{target_name}' not found")


@router.delete("/{name}")
async def delete_model(name: str):
    models = load_models()
    new_models = [m for m in models if m.get("name") != name]
    if len(new_models) == len(models):
        raise HTTPException(status_code=404, detail=f"model '{name}' not found")
    save_models(new_models)
    return {"deleted": name}


@router.post("/{name}/apply")
async def apply_model_by_name(name: str):
    models = load_models()
    for i, m in enumerate(models):
        if m.get("name") == name:
            resolved = _resolve_saved_model(m)
            if resolved.model_dump() != m:
                models[i] = resolved.model_dump()
                save_models(models)
            apply_model(
                resolved.api_key,
                resolved.base_url,
                resolved.model,
                api_type=resolved.api_type,
            )
            return {"applied": name}
    raise HTTPException(status_code=404, detail=f"model '{name}' not found")
