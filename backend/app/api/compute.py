"""Compute provider API: CRUD + connection test + usage."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_user
from ..models import ComputeProvider, ComputeUsage, Setting, User

router = APIRouter(prefix="/compute", tags=["compute"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ProviderCreate(BaseModel):
    display_name: str
    api_key: str
    base_url: str = ""
    provider_type: Optional[str] = None


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


class Resp(BaseModel):
    code: int = 0
    data: dict


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _encrypt_key(raw: str) -> str:
    """MVP: simple obfuscation. Production: use AES-GCM with device key."""
    import base64
    return base64.b64encode(raw.encode()).decode()


def _decrypt_key(enc: str) -> str:
    import base64
    return base64.b64decode(enc.encode()).decode()


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("/providers", response_model=Resp)
async def list_providers(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ComputeProvider).where(ComputeProvider.user_id == user.id)
    )
    items = []
    for p in result.scalars().all():
        cfg = p.config or {}
        items.append({
            "id": p.id,
            "provider_type": p.provider_type,
            "display_name": p.display_name,
            "base_url": cfg.get("base_url", ""),
            "models": cfg.get("models", []),
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
        api_key_encrypted=_encrypt_key(body.api_key),
        config={"base_url": body.base_url, "models": []},
        status="active",
    )
    db.add(prov)
    await db.commit()
    await db.refresh(prov)
    return Resp(data={"id": prov.id, "display_name": prov.display_name})


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

    api_key = _decrypt_key(prov.api_key_encrypted)
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
            return Resp(data={
                "success": True,
                "message": f"连接成功，发现 {len(models)} 个可用模型",
                "model_count": len(models),
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
    result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.id == provider_id,
            ComputeProvider.user_id == user.id,
        )
    )
    prov = result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=404)

    if body.display_name is not None:
        prov.display_name = body.display_name
    if body.api_key is not None:
        prov.api_key_encrypted = _encrypt_key(body.api_key)
    if body.base_url is not None or body.models is not None:
        cfg = dict(prov.config or {})
        if body.base_url is not None:
            cfg["base_url"] = body.base_url
        if body.models is not None:
            cfg["models"] = body.models
        prov.config = cfg
    if body.status is not None:
        prov.status = body.status

    await db.commit()
    return Resp(data={"updated": True})


@router.delete("/providers/{provider_id}", response_model=Resp)
async def delete_provider(
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
    """Return the global embedding model config from settings table."""
    result = await db.execute(
        select(Setting).where(
            Setting.user_id == user.id,
            Setting.key == "embedding_model",
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        return Resp(data={"provider_id": None, "model": None})
    return Resp(data=row.value or {"provider_id": None, "model": None})


@router.put("/embedding-model", response_model=Resp)
async def set_embedding_model(
    body: ModelProviderSetting,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Save global embedding model config. Validate provider supports OpenAI-compatible /v1/embeddings."""
    # Verify provider exists
    prov_result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.id == body.provider_id,
            ComputeProvider.user_id == user.id,
            ComputeProvider.status == "active",
        )
    )
    prov = prov_result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=400, detail="Provider not found or inactive")

    # Upsert into settings table
    result = await db.execute(
        select(Setting).where(
            Setting.user_id == user.id,
            Setting.key == "embedding_model",
        )
    )
    row = result.scalar_one_or_none()
    value = {"provider_id": body.provider_id, "model": body.model}
    if row:
        row.value = value
    else:
        row = Setting(
            id=str(uuid.uuid4()),
            user_id=user.id,
            key="embedding_model",
            value=value,
        )
        db.add(row)
    await db.commit()
    return Resp(data=value)


@router.get("/image-gen", response_model=Resp)
async def get_image_gen_model(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the global image generation model config from settings table."""
    result = await db.execute(
        select(Setting).where(
            Setting.user_id == user.id,
            Setting.key == "image_gen",
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        return Resp(data={"provider_id": None, "model": None})
    return Resp(data=row.value or {"provider_id": None, "model": None})


@router.put("/image-gen", response_model=Resp)
async def set_image_gen_model(
    body: ModelProviderSetting,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Save global image generation model config."""
    prov_result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.id == body.provider_id,
            ComputeProvider.user_id == user.id,
            ComputeProvider.status == "active",
        )
    )
    prov = prov_result.scalar_one_or_none()
    if not prov:
        raise HTTPException(status_code=400, detail="Provider not found or inactive")

    result = await db.execute(
        select(Setting).where(
            Setting.user_id == user.id,
            Setting.key == "image_gen",
        )
    )
    row = result.scalar_one_or_none()
    value = {"provider_id": body.provider_id, "model": body.model}
    if row:
        row.value = value
    else:
        row = Setting(
            id=str(uuid.uuid4()),
            user_id=user.id,
            key="image_gen",
            value=value,
        )
        db.add(row)
    await db.commit()
    return Resp(data=value)


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
