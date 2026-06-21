"""Bootstrap built-in provider template on first start."""

from __future__ import annotations

import logging
import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ComputeProvider, LLMModel

logger = logging.getLogger(__name__)

BUILTIN_PROVIDER_DISPLAY_NAME = "OpenAI Compatible"
BUILTIN_PROVIDER_TYPE = "openai"
BUILTIN_BASE_URL = "https://api.openai.com/v1"

DEFAULT_LLM_MODEL_ID = "gpt-4o-mini"
DEFAULT_LLM_DISPLAY_NAME = "GPT-4o Mini"
DEFAULT_EMBEDDING_MODEL_ID = "text-embedding-3-small"
DEFAULT_EMBEDDING_DISPLAY_NAME = "Text Embedding 3 Small"


async def ensure_builtin_provider(db: AsyncSession) -> Optional[ComputeProvider]:
    """Create a built-in OpenAI-compatible provider template if the table is empty.

    Returns the created provider or None if providers already exist.
    Logs errors but never raises, so startup is not blocked.
    """
    try:
        result = await db.execute(select(ComputeProvider))
        if result.scalars().first():
            logger.debug("Providers table not empty; skipping built-in bootstrap")
            return None

        provider_id = str(uuid.uuid4())

        provider = ComputeProvider(
            id=provider_id,
            provider_type=BUILTIN_PROVIDER_TYPE,
            display_name=BUILTIN_PROVIDER_DISPLAY_NAME,
            api_key_encrypted="",
            config={"base_url": BUILTIN_BASE_URL, "models": []},
            status="active",
            base_url=BUILTIN_BASE_URL,
            auth_mode="api_key",
            custom_headers={},
            request_timeout=120.0,
            max_retries=3,
            rate_limit_qpm=0,
            require_api_key=True,
            is_builtin=True,
            description="Built-in OpenAI-compatible provider template. Configure your API key to use it.",
        )
        db.add(provider)

        default_llm = LLMModel(
            id=f"{provider_id}::{DEFAULT_LLM_MODEL_ID}",
            provider_id=provider_id,
            display_name=DEFAULT_LLM_DISPLAY_NAME,
            is_builtin=True,
            is_default=True,
            status="active",
            model_type="llm",
            context_window=128000,
            max_output_tokens=16384,
            supports_multimodal=True,
            supports_streaming=True,
            supports_tool_calling=True,
            supports_reasoning=False,
        )
        db.add(default_llm)

        # Also seed a default embedding model so an Agent can be saved out of the box.
        default_embedding = LLMModel(
            id=f"{provider_id}::{DEFAULT_EMBEDDING_MODEL_ID}",
            provider_id=provider_id,
            display_name=DEFAULT_EMBEDDING_DISPLAY_NAME,
            is_builtin=True,
            is_default=False,
            status="active",
            model_type="embedding",
            context_window=None,
            max_output_tokens=None,
            supports_multimodal=False,
            supports_streaming=False,
            supports_tool_calling=False,
            supports_reasoning=False,
        )
        db.add(default_embedding)

        await db.commit()
        logger.info(
            "Bootstrapped built-in provider %s with default models %s and %s",
            provider_id,
            DEFAULT_LLM_MODEL_ID,
            DEFAULT_EMBEDDING_MODEL_ID,
        )
        return provider
    except Exception as exc:
        logger.error("Failed to bootstrap built-in provider: %s", exc, exc_info=True)
        try:
            await db.rollback()
        except Exception:
            pass
        return None
