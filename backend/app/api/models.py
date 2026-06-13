"""LLM Model CRUD API.

Models are sub-resources of Providers. API paths use two path params
(provider_id, model_id); DB uses composite key "provider_id::model_id".
"""

from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from typing import Optional, Literal

from ..dependencies import get_db, require_user
from ..models import ComputeProvider, LLMModel, User, Agent
from app.services.provider_migration import sync_provider_yaml, ProviderSyncError

router = APIRouter(prefix="/models", tags=["models"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ModelCreate(BaseModel):
    provider_id: str
    id: str
    display_name: str
    model_type: Literal["llm", "embedding", "image", "stt"] = "llm"
    context_window: Optional[int] = Field(default=None, gt=0)
    max_output_tokens: Optional[int] = Field(default=None, gt=0)
    supports_multimodal: bool = False
    supports_streaming: bool = True
    supports_tool_calling: bool = False
    supports_reasoning: bool = False
    pricing: Optional[dict] = None


class ModelUpdate(BaseModel):
    display_name: Optional[str] = None
    model_type: Optional[Literal["llm", "embedding", "image", "stt"]] = None
    context_window: Optional[int] = None
    max_output_tokens: Optional[int] = None
    supports_multimodal: Optional[bool] = None
    supports_streaming: Optional[bool] = None
    supports_tool_calling: Optional[bool] = None
    supports_reasoning: Optional[bool] = None
    pricing: Optional[dict] = None
    status: Optional[Literal["active", "inactive"]] = None


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _model_to_dict(m: LLMModel) -> dict:
    return {
        "id": m.id.split("::")[-1],
        "provider_id": m.provider_id,
        "display_name": m.display_name,
        "status": m.status,
        "model_type": m.model_type,
        "context_window": m.context_window,
        "max_output_tokens": m.max_output_tokens,
        "supports_multimodal": m.supports_multimodal,
        "supports_streaming": m.supports_streaming,
        "supports_tool_calling": m.supports_tool_calling,
        "supports_reasoning": m.supports_reasoning,
        "pricing": m.pricing,
    }


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("", response_model=Resp)
async def list_models(
    provider_id: Optional[str] = None,
    model_type: Optional[str] = None,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """List models. If provider_id given, return only its models."""
    stmt = select(LLMModel).where(LLMModel.user_id == user.id)
    if provider_id:
        stmt = stmt.where(LLMModel.provider_id == provider_id)
    if model_type:
        stmt = stmt.where(LLMModel.model_type == model_type)
    result = await db.execute(stmt)
    items = [_model_to_dict(m) for m in result.scalars().all()]
    return Resp(data={"items": items})


@router.post("", response_model=Resp)
async def create_model(
    body: ModelCreate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify provider exists
    prov = await db.get(ComputeProvider, body.provider_id)
    if not prov or prov.user_id != user.id:
        raise HTTPException(status_code=400, detail="Provider not found")

    composite_id = f"{body.provider_id}::{body.id}"
    existing = await db.get(LLMModel, composite_id)
    if existing:
        raise HTTPException(status_code=409, detail="Model already exists")

    m = LLMModel(
        id=composite_id,
        provider_id=body.provider_id,
        user_id=user.id,
        display_name=body.display_name,
        model_type=body.model_type,
        context_window=body.context_window,
        max_output_tokens=body.max_output_tokens,
        supports_multimodal=body.supports_multimodal,
        supports_streaming=body.supports_streaming,
        supports_tool_calling=body.supports_tool_calling,
        supports_reasoning=body.supports_reasoning,
        pricing=body.pricing,
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    # Sync provider back to YAML with updated models list
    db.expire_all()
    result = await db.execute(
        select(ComputeProvider)
        .where(ComputeProvider.id == body.provider_id)
        .options(selectinload(ComputeProvider.models))
        .execution_options(populate_existing=True)
    )
    prov = result.scalar_one()
    try:
        sync_provider_yaml("upsert", prov)
    except ProviderSyncError as exc:
        logging.getLogger(__name__).error("Model create sync failed for %s: %s", body.provider_id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    return Resp(data={"id": body.id, "provider_id": body.provider_id})


@router.put("/{provider_id}/{model_id}", response_model=Resp)
async def update_model(
    provider_id: str,
    model_id: str,
    body: ModelUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    composite_id = f"{provider_id}::{model_id}"
    m = await db.get(LLMModel, composite_id)
    if not m or m.user_id != user.id:
        raise HTTPException(status_code=404)

    if body.display_name is not None:
        m.display_name = body.display_name
    if body.model_type is not None:
        m.model_type = body.model_type
    if body.context_window is not None:
        m.context_window = body.context_window
    if body.max_output_tokens is not None:
        m.max_output_tokens = body.max_output_tokens
    if body.supports_multimodal is not None:
        m.supports_multimodal = body.supports_multimodal
    if body.supports_streaming is not None:
        m.supports_streaming = body.supports_streaming
    if body.supports_tool_calling is not None:
        m.supports_tool_calling = body.supports_tool_calling
    if body.supports_reasoning is not None:
        m.supports_reasoning = body.supports_reasoning
    if body.pricing is not None:
        m.pricing = body.pricing
    if body.status is not None:
        m.status = body.status

    await db.commit()
    # Sync provider back to YAML with updated models list
    db.expire_all()
    result = await db.execute(
        select(ComputeProvider)
        .where(ComputeProvider.id == provider_id)
        .options(selectinload(ComputeProvider.models))
        .execution_options(populate_existing=True)
    )
    prov = result.scalar_one()
    try:
        sync_provider_yaml("upsert", prov)
    except ProviderSyncError as exc:
        logging.getLogger(__name__).error("Model update sync failed for %s: %s", provider_id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    return Resp(data={"updated": True})


@router.delete("/{provider_id}/{model_id}", response_model=Resp)
async def delete_model(
    provider_id: str,
    model_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    composite_id = f"{provider_id}::{model_id}"
    m = await db.get(LLMModel, composite_id)
    if not m or m.user_id != user.id:
        raise HTTPException(status_code=404)

    # Check if any Agent references this model
    # Check main model
    refs = []
    result = await db.execute(
        select(Agent).where(
            Agent.user_id == user.id,
            Agent.provider_id == provider_id,
            Agent.model_id == model_id,
        )
    )
    refs.extend(result.scalars().all())

    # Check marker / embedder / compressor
    for col_pair in [
        ("marker_provider_id", "marker_model_id"),
        ("embedder_provider_id", "embedder_model_id"),
        ("compressor_provider_id", "compressor_model_id"),
    ]:
        prov_col, model_col = col_pair
        result = await db.execute(
            select(Agent).where(
                Agent.user_id == user.id,
                getattr(Agent, prov_col) == provider_id,
                getattr(Agent, model_col) == model_id,
            )
        )
        refs.extend(result.scalars().all())

    # Check fallback_chain JSON (simplified: string search)
    result = await db.execute(
        select(Agent).where(
            Agent.user_id == user.id,
            Agent.fallback_chain.isnot(None),
        )
    )
    for agent in result.scalars().all():
        chain = agent.fallback_chain or []
        for item in chain:
            if item.get("provider_id") == provider_id and item.get("model_id") == model_id:
                if agent not in refs:
                    refs.append(agent)
                break

    if refs:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Model is referenced by agents",
                "agents": [{"id": a.id, "name": a.name} for a in refs[:10]],
            },
        )

    await db.delete(m)
    await db.commit()
    # Sync provider back to YAML with updated models list
    db.expire_all()
    result = await db.execute(
        select(ComputeProvider)
        .where(ComputeProvider.id == provider_id)
        .options(selectinload(ComputeProvider.models))
        .execution_options(populate_existing=True)
    )
    prov = result.scalar_one()
    try:
        sync_provider_yaml("upsert", prov)
    except ProviderSyncError as exc:
        logging.getLogger(__name__).error("Model delete sync failed for %s: %s", provider_id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    return Resp(data={"deleted": True})
