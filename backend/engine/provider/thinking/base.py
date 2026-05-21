"""ThinkingProfile base class.

Design reference: §6.2.2 - 每家 Provider 的 thinking 行为封装
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LLMResponse:
    """Normalized response from any provider.

    Design reference: Inspired by Hermes NormalizedResponse, simplified.
    """

    content: str | None = None
    reasoning_content: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    # Raw provider response for debugging
    raw: Any = None


class ThinkingProfile(ABC):
    """Base class for provider-specific thinking behavior.

    Each provider handles thinking parameters and reasoning_content differently.
    This class encapsulates those differences so the Transport stays clean.
    """

    @abstractmethod
    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        """Inject thinking-related parameters into the API call kwargs.

        For example, DeepSeek adds `extra_body={"thinking": {"type": "enabled", ...}}`
        while GLM adds `extra_body={"enable_thinking": True}`.

        Args:
            kwargs: The existing kwargs dict to modify.

        Returns:
            The modified kwargs dict with thinking params injected.
        """

    @abstractmethod
    def extract(self, response: Any) -> str | None:
        """Extract reasoning_content from a raw provider response.

        Different providers put thinking in different places:
        - DeepSeek/MiMo/Kimi: response.choices[0].message.reasoning_content
        - GLM: varies, may need special handling

        Args:
            response: The raw response object from the OpenAI-compatible API.

        Returns:
            The reasoning content string, or None if not present.
        """

    @abstractmethod
    def normalize_content(self, message: dict) -> dict:
        """Handle content-empty fallback for providers that may return
        empty content when thinking is active.

        Some providers return content="" when tool_calls are present during
        thinking mode. This method ensures a safe fallback.

        Args:
            message: The message dict from the API response.

        Returns:
            The message dict, potentially with content normalized.
        """

    @abstractmethod
    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        """Whether reasoning_content must be echoed back in the next message.

        For DeepSeek/MiMo/Kimi: reasoning_content must be included in the
        next user/assistant message when tool_calls are present.

        Args:
            has_tool_calls: Whether the current response has tool_calls.

        Returns:
            True if reasoning_content should be echoed back.
        """