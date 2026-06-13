"""Fallback chain: provider degradation on failure.

Design reference: §6.9.4 Provider 降级链
Updated: provider_id + model_id based fallback nodes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .classifier import ClassifiedError, FailoverReason

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FallbackNode:
    """A single node in the fallback chain."""

    provider_id: str
    model_id: str
    display_name: str = ""

    @property
    def key(self) -> str:
        """Composite key for transport dict lookup."""
        return f"{self.provider_id}::{self.model_id}"


class FallbackChain:
    """Manages provider fallback when errors occur.

    Design reference: §6.9.4 - 配置声明降级链
    """

    def __init__(self, chain: list[FallbackNode]):
        """Initialize with fallback chain from config.

        Args:
            chain: List of FallbackNode in fallback order.
        """
        self._chain = chain
        self._current_index = 0

    @property
    def current_node(self) -> FallbackNode:
        """Current active fallback node."""
        if self._current_index < len(self._chain):
            return self._chain[self._current_index]
        return self._chain[-1]

    @property
    def current_provider(self) -> str:
        """Current active provider name (for backward compat / logging)."""
        return self.current_node.display_name or self.current_node.provider_id

    def should_fallback(self, error: ClassifiedError) -> bool:
        """Determine if we should fallback to the next provider.

        Args:
            error: Classified error from the current provider.

        Returns:
            True if we should try the next provider.
        """
        if self._current_index >= len(self._chain) - 1:
            return False

        fallback_reasons = {
            FailoverReason.auth_permanent,
            FailoverReason.model_not_found,
            FailoverReason.rate_limit,
            FailoverReason.server_error,
            FailoverReason.empty_response,
        }
        return error.reason in fallback_reasons

    def fallback(self) -> FallbackNode | None:
        """Move to the next provider in the fallback chain.

        Returns:
            The next FallbackNode, or None if exhausted.
        """
        if self._current_index >= len(self._chain) - 1:
            logger.warning("Fallback chain exhausted, no more providers")
            return None

        old = self.current_node
        self._current_index += 1
        new = self.current_node

        logger.warning("Falling back from %s to %s", old.display_name or old.provider_id, new.display_name or new.provider_id)
        return new

    def reset(self) -> None:
        """Reset to the primary provider (for new conversations)."""
        self._current_index = 0


def _parse_fallback_chain(raw: list[dict]) -> list[FallbackNode]:
    """Parse fallback chain from raw config (backward compatible).

    Supports:
    - New format: [{"provider_id": "x", "model_id": "y", "display_name": "z"}]
    - Old format: [{"provider": "deepseek", "model": "deepseek-chat"}]
    """
    nodes: list[FallbackNode] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        if "provider_id" in item and "model_id" in item:
            nodes.append(FallbackNode(
                provider_id=item["provider_id"],
                model_id=item["model_id"],
                display_name=item.get("display_name", ""),
            ))
        elif "provider" in item:
            # Old format: convert provider name -> provider_id + model_id
            provider_name = item["provider"]
            model_name = item.get("model", "")
            logger.warning(
                "Fallback chain uses legacy format 'provider': '%s'. "
                "Consider migrating to 'provider_id' + 'model_id'.",
                provider_name,
            )
            # Store as-is; agent_worker will resolve at runtime
            nodes.append(FallbackNode(
                provider_id=provider_name,  # Will be treated as name in _resolve_provider
                model_id=model_name,
                display_name=provider_name,
            ))
    return nodes