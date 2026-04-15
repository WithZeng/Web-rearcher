from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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


@router.get("/", response_model=ModelListResponse)
async def list_models():
    return ModelListResponse(models=[ModelEntry(**m) for m in load_models()])


@router.post("/", response_model=ModelEntry)
async def create_model(entry: ModelEntry):
    models = load_models()
    if any(m.get("name") == entry.name for m in models):
        raise HTTPException(status_code=409, detail=f"model '{entry.name}' already exists")
    models.append(entry.model_dump())
    save_models(models)
    return entry


@router.put("/{name}", response_model=ModelEntry)
async def update_model(name: str, entry: ModelEntry):
    models = load_models()
    for i, m in enumerate(models):
        if m.get("name") == name:
            models[i] = entry.model_dump()
            save_models(models)
            return entry
    raise HTTPException(status_code=404, detail=f"model '{name}' not found")


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
    for m in models:
        if m.get("name") == name:
            apply_model(
                m.get("api_key", ""),
                m.get("base_url", ""),
                m.get("model", "") or m.get("model_name", "gpt-4o-mini"),
                api_type=m.get("api_type", "openai"),
            )
            return {"applied": name}
    raise HTTPException(status_code=404, detail=f"model '{name}' not found")
