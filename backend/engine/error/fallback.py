"""Fallback chain: provider degradation on failure.

Design reference: §6.9.4 Provider 降级链
"""

from __future__ import annotations

import logging

from .classifier import ClassifiedError, FailoverReason

logger = logging.getLogger(__name__)


class FallbackChain:
    """Manages provider fallback when errors occur.

    Design reference: §6.9.4 - 配置声明降级链
    """

    def __init__(self, chain: list[str]):
        """Initialize with fallback chain from config.

        Args:
            chain: List of provider names in fallback order.
                   e.g. ["deepseek", "mimo", "kimicode", "glm"]
        """
        self._chain = chain
        self._current_index = 0

    @property
    def current_provider(self) -> str:
        """Current active provider name."""
        if self._current_index < len(self._chain):
            return self._chain[self._current_index]
        return self._chain[-1]  # Stay on last provider

    def should_fallback(self, error: ClassifiedError) -> bool:
        """Determine if we should fallback to the next provider.

        Args:
            error: Classified error from the current provider.

        Returns:
            True if we should try the next provider.
        """
        # Don't fallback if no more providers available
        if self._current_index >= len(self._chain) - 1:
            return False

        # Fallback on these error types
        fallback_reasons = {
            FailoverReason.auth_permanent,
            FailoverReason.model_not_found,
            FailoverReason.rate_limit,  # After retries exhausted
            FailoverReason.server_error,  # After retries exhausted
            FailoverReason.empty_response,  # After retries
        }

        return error.reason in fallback_reasons

    def fallback(self) -> str | None:
        """Move to the next provider in the fallback chain.

        Returns:
            The next provider name, or None if exhausted.
        """
        if self._current_index >= len(self._chain) - 1:
            logger.warning("Fallback chain exhausted, no more providers")
            return None

        old = self.current_provider
        self._current_index += 1
        new = self.current_provider

        logger.warning("Falling back from %s to %s", old, new)
        return new

    def reset(self) -> None:
        """Reset to the primary provider (for new conversations)."""
        self._current_index = 0