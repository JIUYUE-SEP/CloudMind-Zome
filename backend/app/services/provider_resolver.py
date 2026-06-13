"""Unified provider credential resolution.

Centralizes all provider credential lookups:
- agent_worker._build_transport()  → resolve_provider_credentials()
- engine_bridge._build_transport() → resolve_provider_credentials()
- main.py Embedding / ImageGen init → resolve_provider_credentials()
- agents.py personality analysis     → resolve_provider_credentials()
- marker.py / extractor.py          → resolve_provider_credentials()
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt_value
from app.models import ComputeProvider, LLMModel


@dataclass(frozen=True)
class ResolvedCredentials:
    provider_id: str
    provider_type: str
    model_id: str
    base_url: str
    api_key: str | None
    auth_mode: str
    custom_headers: dict[str, str]
    request_timeout: float
    max_retries: int


@dataclass(frozen=True)
class ResolvedModel:
    model_id: str
    display_name: str
    context_window: Optional[int]
    max_output_tokens: Optional[int]
    supports_reasoning: bool
    supports_tool_calling: bool
    supports_multimodal: bool


async def resolve_provider_credentials(
    db: AsyncSession,
    provider_id: str,
    model_id: str | None = None,
) -> ResolvedCredentials | None:
    """Resolve provider credentials from ComputeProvider table.

    Returns None if provider not found or inactive.
    """
    if not provider_id:
        return None

    prov = await db.get(ComputeProvider, provider_id)
    if not prov or prov.status != "active":
        return None

    api_key = None
    if prov.api_key_encrypted:
        try:
            api_key = decrypt_value(prov.api_key_encrypted)
        except Exception:
            api_key = prov.api_key_encrypted

    effective_model = model_id or ""
    if not effective_model and prov.models:
        # Use first active model
        for m in prov.models:
            if m.status == "active":
                effective_model = m.id.split("::")[-1]  # composite -> local id
                break

    return ResolvedCredentials(
        provider_id=prov.id,
        provider_type=prov.provider_type,
        model_id=effective_model,
        base_url=prov.base_url or (prov.config or {}).get("base_url", ""),
        api_key=api_key,
        auth_mode=prov.auth_mode,
        custom_headers=prov.custom_headers or {},
        request_timeout=prov.request_timeout,
        max_retries=prov.max_retries,
    )


async def resolve_model_attributes(
    db: AsyncSession,
    provider_id: str,
    model_id: str,
) -> ResolvedModel:
    """Resolve model physical attributes from LLMModel table.

    Returns conservative defaults if not found.
    """
    if not provider_id or not model_id:
        return ResolvedModel(
            model_id=model_id or "",
            display_name=model_id or "unknown",
            context_window=32000,
            max_output_tokens=4096,
            supports_reasoning=False,
            supports_tool_calling=False,
            supports_multimodal=False,
        )

    composite_id = f"{provider_id}::{model_id}"
    model = await db.get(LLMModel, composite_id)
    if model:
        return ResolvedModel(
            model_id=model_id,
            display_name=model.display_name,
            context_window=model.context_window if model.context_window is not None else 32000,
            max_output_tokens=model.max_output_tokens if model.max_output_tokens is not None else 4096,
            supports_reasoning=model.supports_reasoning,
            supports_tool_calling=model.supports_tool_calling,
            supports_multimodal=model.supports_multimodal,
        )

    return ResolvedModel(
        model_id=model_id,
        display_name=model_id,
        context_window=32000,
        max_output_tokens=4096,
        supports_reasoning=False,
        supports_tool_calling=False,
        supports_multimodal=False,
    )
