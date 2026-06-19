"""Compute provider API: CRUD + connection test + usage."""

from __future__ import annotations

import logging
import re
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_user
from ..models import ComputeProvider, ComputeUsage, User
from app.core.crypto import encrypt_value, decrypt_value
from app.services.provider_migration import sync_provider_yaml, ProviderSyncError

router = APIRouter(prefix="/compute", tags=["compute"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ProviderCreate(BaseModel):
    display_name: str
    api_key: str = ""
    base_url: str = ""
    provider_type: Optional[str] = None
    auth_mode: str = "api_key"
    custom_headers: Optional[dict] = None
    request_timeout: float = 120.0
    max_retries: int = 3
    rate_limit_qpm: int = 0
    require_api_key: bool = True
    description: Optional[str] = None


def _detect_provider_type(base_url: str) -> str:
    base_url = base_url.lower()
    if "deepseek" in base_url:
        return "deepseek"
    if "siliconflow" in base_url or "silicon" in base_url:
        return "siliconflow"
    if "openai" in base_url:
        return "openai"
    return "openai"


class ProviderUpdate(BaseModel):
    display_name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    models: Optional[list[str]] = None
    status: Optional[str] = None
    auth_mode: Optional[str] = None
    custom_headers: Optional[dict] = None
    request_timeout: Optional[float] = None
    max_retries: Optional[int] = None
    rate_limit_qpm: Optional[int] = None
    require_api_key: Optional[bool] = None
    description: Optional[str] = None


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("/providers", response_model=Resp)
async def list_providers(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(ComputeProvider)
        .where(ComputeProvider.user_id == user.id)
        .options(selectinload(ComputeProvider.models))
    )
    items = []
    for p in result.scalars().all():
        model_objs = []
        for m in p.models:
            model_objs.append({
                "id": m.id.split("::")[-1],
                "display_name": m.display_name,
                "model_type": m.model_type,
                "context_window": m.context_window,
                "max_output_tokens": m.max_output_tokens,
                "supports_multimodal": m.supports_multimodal,
                "supports_streaming": m.supports_streaming,
                "supports_tool_calling": m.supports_tool_calling,
                "supports_reasoning": m.supports_reasoning,
                "is_default": m.is_default,
                "status": m.status,
            })
        items.append({
            "id": p.id,
            "provider_type": p.provider_type,
            "display_name": p.display_name,
            "base_url": p.base_url or (p.config or {}).get("base_url", ""),
            "api_key": "********" if p.api_key_encrypted else "",
            "has_api_key": bool(p.api_key_encrypted),
            "models": model_objs,
            "auth_mode": p.auth_mode,
            "request_timeout": p.request_timeout,
            "max_retries": p.max_retries,
            "rate_limit_qpm": p.rate_limit_qpm,
            "require_api_key": p.require_api_key,
            "is_builtin": p.is_builtin,
            "description": p.description,
            "quota_total": p.quota_total,
            "quota_used": p.quota_used,
            "quota_remaining": p.quota_remaining,
            "expires_at": p.expires_at.isoformat() if p.expires_at else None,
            "status": p.status,
            "last_sync_at": p.last_sync_at.isoformat() if p.last_sync_at else None,
        })
    return Resp(data={"items": items})


@router.post("/providers", response_model=Resp)
async def create_provider(
    body: ProviderCreate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    provider_type = body.provider_type or _detect_provider_type(body.base_url)
    prov = ComputeProvider(
        id=str(uuid.uuid4()),
        user_id=user.id,
        provider_type=provider_type,
        display_name=body.display_name,
        api_key_encrypted=encrypt_value(body.api_key) if body.api_key else "",
        config={"base_url": body.base_url, "models": []},
        status="active",
        base_url=body.base_url,
        auth_mode=body.auth_mode,
        custom_headers=body.custom_headers or {},
        request_timeout=body.request_timeout,
        max_retries=body.max_retries,
        rate_limit_qpm=body.rate_limit_qpm,
        require_api_key=body.require_api_key,
        description=body.description,
    )
    db.add(prov)
    prov_id = prov.id
    try:
        await db.flush()
        # Eager-load models so the synchronous YAML helper does not trigger
        # a lazy query inside an async context.
        await db.refresh(prov, attribute_names=["models"])
        sync_provider_yaml("upsert", prov)
        await db.commit()
    except ProviderSyncError as exc:
        await db.rollback()
        logger.error("Provider create sync failed for %s: %s", prov_id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    except Exception:
        await db.rollback()
        raise
    return Resp(data={"id": prov.id, "display_name": prov.display_name})


def infer_model_type(model_id: str) -> str:
    lower = model_id.lower()
    DISCOVERY_RULES = [
        (r"\b(ada-002|ada\b|text-embedding|embedding|embed|bge-|e5-|gte-|m3e-|m-e5|multilingual-e5|nv-embed)", "embedding"),
        (r"\b(dall-e|flux|sdxl|stable-diffusion|midjourney|wanx|cogview|kling|imagen|playground|recraft|ideogram)", "image"),
        (r"\b(whisper|sensevoice|sense|nova-|stt-|asr-|speech-to-text|speech)", "stt"),
    ]
    for pattern, t in DISCOVERY_RULES:
        if re.search(pattern, lower):
            return t
    return "llm"


@router.post("/providers/{provider_id}/test", response_model=Resp)
async def test_provider(
    provider_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.id == provider_id,
            ComputeProvider.user_id == user.id,
        )
    )
    prov = result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=404)

    api_key = decrypt_value(prov.api_key_encrypted)
    base_url = (prov.config or {}).get("base_url", "")

    # Quick connectivity test via a cheap models.list call
    try:
        import httpx
        url = f"{base_url.rstrip('/')}/models"
        headers = {"Authorization": f"Bearer {api_key}"}
        r = httpx.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            data = r.json()
            models = data.get("data", [])
            model_ids = [m.get("id", "") for m in models if m.get("id")]
            # Persist models to DB so AgentEdit can pick them
            cfg = dict(prov.config or {})
            cfg["models"] = model_ids
            prov.config = cfg
            await db.commit()
            discovered_models = [
                {
                    "id": m_id,
                    "type_hint": infer_model_type(m_id),
                }
                for m_id in model_ids
            ]
            return Resp(data={
                "success": True,
                "message": f"连接成功，发现 {len(models)} 个可用模型",
                "model_count": len(models),
                "discovered_models": discovered_models,
                "models": model_ids,
            })
        else:
            return Resp(data={
                "success": False,
                "message": f"连接失败: HTTP {r.status_code}",
            })
    except Exception as e:
        return Resp(data={"success": False, "message": f"连接失败: {e}"})


@router.put("/providers/{provider_id}", response_model=Resp)
async def update_provider(
    provider_id: str,
    body: ProviderUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(ComputeProvider)
        .where(
            ComputeProvider.id == provider_id,
            ComputeProvider.user_id == user.id,
        )
        .options(selectinload(ComputeProvider.models))
    )
    prov = result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=404)

    if body.display_name is not None:
        prov.display_name = body.display_name
    # Preserve existing API key when frontend sends empty string or omits the field.
    if body.api_key:
        prov.api_key_encrypted = encrypt_value(body.api_key)
    if body.base_url is not None:
        prov.base_url = body.base_url
        cfg = dict(prov.config or {})
        cfg["base_url"] = body.base_url
        prov.config = cfg
    if body.models is not None:
        cfg = dict(prov.config or {})
        cfg["models"] = body.models
        prov.config = cfg
    if body.status is not None:
        prov.status = body.status
    if body.auth_mode is not None:
        prov.auth_mode = body.auth_mode
    if body.custom_headers is not None:
        prov.custom_headers = body.custom_headers
    if body.request_timeout is not None:
        prov.request_timeout = body.request_timeout
    if body.max_retries is not None:
        prov.max_retries = body.max_retries
    if body.rate_limit_qpm is not None:
        prov.rate_limit_qpm = body.rate_limit_qpm
    if body.require_api_key is not None:
        prov.require_api_key = body.require_api_key
    if body.description is not None:
        prov.description = body.description

    try:
        await db.flush()
        sync_provider_yaml("upsert", prov)
        await db.commit()
    except ProviderSyncError as exc:
        await db.rollback()
        logger.error("Provider update sync failed for %s: %s", provider_id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    except Exception:
        await db.rollback()
        raise
    return Resp(data={"updated": True})


@router.delete("/providers/{provider_id}", response_model=Resp)
async def delete_provider(
    provider_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    from ..models import Agent
    result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.id == provider_id,
            ComputeProvider.user_id == user.id,
        )
    )
    prov = result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=404)

    # Refuse to delete built-in providers
    if prov.is_builtin:
        raise HTTPException(status_code=403, detail="Cannot delete built-in provider")

    # Check agent references
    refs = []
    for col in ["provider_id", "marker_provider_id", "embedder_provider_id", "compressor_provider_id"]:
        r = await db.execute(
            select(Agent).where(
                Agent.user_id == user.id,
                getattr(Agent, col) == provider_id,
            )
        )
        for a in r.scalars().all():
            if a not in refs:
                refs.append(a)

    # Check fallback_chain JSON
    r = await db.execute(
        select(Agent).where(
            Agent.user_id == user.id,
            Agent.fallback_chain.isnot(None),
        )
    )
    for a in r.scalars().all():
        chain = a.fallback_chain or []
        for item in chain:
            if item.get("provider_id") == provider_id:
                if a not in refs:
                    refs.append(a)
                break

    if refs:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Provider is referenced by agents",
                "agents": [{"id": a.id, "name": a.name} for a in refs[:10]],
            },
        )

    try:
        sync_provider_yaml("delete", prov)
    except ProviderSyncError as exc:
        logger.error("Provider delete sync failed for %s: %s", prov.id, exc)
        raise HTTPException(status_code=500, detail=f"Provider sync failed: {exc}")
    await db.delete(prov)
    await db.commit()
    return Resp(data={"deleted": True})


# ------------------------------------------------------------------
# Embedding model global config (stored in settings table)
# ------------------------------------------------------------------
class ModelProviderSetting(BaseModel):
    provider_id: str
    model: str


@router.get("/embedding-model", response_model=Resp)
async def get_embedding_model(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """DEPRECATED: Embedding model is now agent-level. Return empty for backward compat."""
    return Resp(data={"provider_id": None, "model": None})


@router.put("/embedding-model", response_model=Resp)
async def set_embedding_model(
    body: ModelProviderSetting,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """DEPRECATED: Embedding model is now agent-level."""
    return Resp(code=400, data={"message": "Embedding model is now configured per-agent. Use AgentEdit -> Compute tab."})


@router.get("/image-gen", response_model=Resp)
async def get_image_gen_model(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """DEPRECATED: Image generation is now agent-level. Return empty for backward compat."""
    return Resp(data={"provider_id": None, "model": None})


@router.put("/image-gen", response_model=Resp)
async def set_image_gen_model(
    body: ModelProviderSetting,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """DEPRECATED: Image generation is now agent-level."""
    return Resp(code=400, data={"message": "Image generation is now configured per-agent. Use AgentEdit -> Compute tab."})


@router.get("/usage", response_model=Resp)
async def get_usage(
    provider_id: Optional[str] = None,
    days: int = 7,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ComputeUsage).where(ComputeUsage.provider_id == provider_id) if provider_id else select(ComputeUsage)
    # Simple daily aggregation (MVP: return last N records)
    result = await db.execute(stmt.order_by(ComputeUsage.date.desc()).limit(days))
    items = [
        {
            "date": u.date,
            "tokens_prompt": u.tokens_prompt,
            "tokens_completion": u.tokens_completion,
            "tokens_total": u.tokens_total,
        }
        for u in result.scalars().all()
    ]
    return Resp(data={
        "dates": [i["date"] for i in reversed(items)],
        "tokens": [i["tokens_total"] for i in reversed(items)],
    })
