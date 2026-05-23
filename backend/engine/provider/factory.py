"""Transport factory — builds ChatCompletionsTransport from resolved credentials.

Pure engine-layer code. All database lookups are provided by the platform
layer via the `resolve_config` callback.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

from .transport import ChatCompletionsTransport
from .thinking.deepseek import DeepSeekThinkingProfile
from .thinking.glm import GLMThinkingProfile
from .thinking.kimicode import KimiCodeThinkingProfile
from .thinking.mimo import MiMoThinkingProfile

logger = logging.getLogger(__name__)

_PROFILE_MAP = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,
}

_DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com/v1",
    "mimo": "https://api.miaomi.cn/v1",
    "kimicode": "https://api.kimi.ai/v1",
    "glm": "https://api.glm.ai/v1",
}


async def build_transport(
    provider_type: str,
    model_name: str,
    resolve_config: Callable[[str], Awaitable[dict | None]],
) -> ChatCompletionsTransport | None:
    """Build a ChatCompletionsTransport.

    Args:
        provider_type: e.g. "deepseek", "glm".
        model_name: e.g. "deepseek-v4-pro".
        resolve_config: async callback that receives provider_type and returns
            {"base_url": str, "api_key": str} or None.
    """
    resolved = await resolve_config(provider_type)

    base_url = _DEFAULT_BASE_URLS.get(provider_type, "")
    api_key = ""

    if resolved:
        base_url = resolved.get("base_url") or base_url
        api_key = resolved.get("api_key", "")

    if not api_key:
        logger.error("No API key resolved for provider %s", provider_type)
        return None

    profile_cls = _PROFILE_MAP.get(provider_type, DeepSeekThinkingProfile)
    return ChatCompletionsTransport(
        base_url=base_url,
        api_key=api_key,
        model=model_name,
        thinking_profile=profile_cls(),
    )
