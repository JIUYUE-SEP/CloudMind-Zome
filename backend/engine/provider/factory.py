"""Transport factory — builds ChatCompletionsTransport from resolved credentials.

Pure engine-layer code. All database lookups are provided by the platform
layer via the `resolve_config` callback.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Type

from .transport import ChatCompletionsTransport
from .thinking.base import ThinkingProfile
from .thinking.deepseek import DeepSeekThinkingProfile
from .thinking.glm import GLMThinkingProfile
from .thinking.kimicode import KimiCodeThinkingProfile
from .thinking.mimo import MiMoThinkingProfile

logger = logging.getLogger(__name__)

_BUILTIN_PROFILES: dict[str, Type[ThinkingProfile]] = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,
    "ollama": DeepSeekThinkingProfile,
}

def resolve_profile(provider_type: str, custom_profile: str | None = None) -> Type[ThinkingProfile]:
    """Resolve ThinkingProfile class for a provider type.

    - custom_profile: optional override from Provider config (reserved for future use)
    - Unknown types fall back to DeepSeekThinkingProfile (most general, supports
      reasoning + tool_calls via OpenAI-compatible format).
    """
    if custom_profile and custom_profile in _BUILTIN_PROFILES:
        return _BUILTIN_PROFILES[custom_profile]
    return _BUILTIN_PROFILES.get(provider_type, DeepSeekThinkingProfile)


async def build_transport(
    provider_type: str,
    model_name: str,
    resolve_config: Callable[[str], Awaitable[dict | None]],
    *,
    custom_profile: str | None = None,
    auth_mode: str = "api_key",
    custom_headers: dict[str, str] | None = None,
    request_timeout: float = 120.0,
    max_retries: int = 3,
) -> ChatCompletionsTransport | None:
    """Build a ChatCompletionsTransport.

    Args:
        provider_type: e.g. "deepseek", "glm".
        model_name: e.g. "deepseek-v4-pro".
        resolve_config: async callback that receives provider_type and returns
            {"base_url": str, "api_key": str} or None.
        custom_profile: optional ThinkingProfile override.
        auth_mode: api_key | bearer | none.
        custom_headers: extra HTTP headers.
        request_timeout: request timeout in seconds.
        max_retries: retry count.
    """
    resolved = await resolve_config(provider_type)

    if not resolved:
        logger.error("No credentials resolved for provider %s", provider_type)
        return None

    base_url = resolved.get("base_url", "")
    api_key = resolved.get("api_key", "")

    if not base_url:
        logger.error("No base_url resolved for provider %s", provider_type)
        return None

    if auth_mode != "none" and not api_key:
        logger.error("No API key resolved for provider %s (auth_mode=%s)", provider_type, auth_mode)
        return None

    profile_cls = resolve_profile(provider_type, custom_profile)
    return ChatCompletionsTransport(
        base_url=base_url,
        api_key=api_key or "sk-dummy",
        model=model_name,
        thinking_profile=profile_cls(),
        auth_mode=auth_mode,
        custom_headers=custom_headers,
        timeout=request_timeout,
        max_retries=max_retries,
    )
