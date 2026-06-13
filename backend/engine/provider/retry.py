"""Unified retry logic for LLM provider calls.

Design reference: §6.9.3 重试策略详表
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TypeVar

from ..error.classifier import classify_error

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ErrorCategory:
    """Retry-oriented error categories.

    Mirrors FailoverReason from engine.error.classifier while focusing on
    the retry decision only.
    """

    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    SERVICE_UNAVAILABLE = "server_error"
    NETWORK = "network"
    AUTH = "auth"
    MODEL_NOT_SUPPORTED = "model_not_found"
    PARAM_ERROR = "format_error"
    UNKNOWN = "unknown"


# Error categories that are retryable by default.
RETRYABLE_CATEGORIES: set[str] = {
    ErrorCategory.RATE_LIMIT,
    ErrorCategory.TIMEOUT,
    ErrorCategory.SERVICE_UNAVAILABLE,
    ErrorCategory.NETWORK,
}

# Error categories that should not be retried by default.
NON_RETRYABLE_CATEGORIES: set[str] = {
    ErrorCategory.AUTH,
    ErrorCategory.MODEL_NOT_SUPPORTED,
    ErrorCategory.PARAM_ERROR,
    ErrorCategory.UNKNOWN,
}


@dataclass
class RetryConfig:
    """Retry configuration for unified retry helper."""

    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    jitter: bool = True
    retryable_categories: set[str] = field(default_factory=lambda: set(RETRYABLE_CATEGORIES))
    non_retryable_categories: set[str] = field(default_factory=lambda: set(NON_RETRYABLE_CATEGORIES))

    def is_retryable(self, category: str) -> bool:
        """Determine whether a given error category should be retried."""
        if category in self.non_retryable_categories:
            return False
        return category in self.retryable_categories

    def compute_delay(self, attempt: int) -> float:
        """Compute exponential backoff delay with optional jitter.

        Args:
            attempt: Current retry attempt (0-indexed). attempt=0 is the first retry.

        Returns:
            Delay in seconds.
        """
        delay = min(self.base_delay * (2**attempt), self.max_delay)
        if self.jitter:
            delay += random.uniform(0, self.base_delay)
        return delay


def _default_classify(error: Exception, provider: str = "", model: str = "") -> str:
    """Default classifier bridging ClassifiedError to ErrorCategory strings."""
    classified = classify_error(error, provider=provider, model=model)
    reason_value = classified.reason.value
    mapping = {
        "rate_limit": ErrorCategory.RATE_LIMIT,
        "timeout": ErrorCategory.TIMEOUT,
        "server_error": ErrorCategory.SERVICE_UNAVAILABLE,
        "auth": ErrorCategory.AUTH,
        "auth_permanent": ErrorCategory.AUTH,
        "model_not_found": ErrorCategory.MODEL_NOT_SUPPORTED,
        "format_error": ErrorCategory.PARAM_ERROR,
        "context_overflow": ErrorCategory.PARAM_ERROR,
        "empty_response": ErrorCategory.UNKNOWN,
    }
    if not classified.retryable and mapping.get(reason_value) in RETRYABLE_CATEGORIES:
        # Honor classifier's retryable flag over the coarse category mapping.
        return ErrorCategory.UNKNOWN
    return mapping.get(reason_value, ErrorCategory.UNKNOWN)


async def call_with_retry(
    fn: Callable[[], Awaitable[T]],
    classify_error_fn: Callable[[Exception], str] | None = None,
    config: RetryConfig | None = None,
) -> T:
    """Call an async function with unified retry logic.

    Args:
        fn: Zero-argument async callable to retry.
        classify_error_fn: Callable that maps an exception to an ErrorCategory string.
            If None, the default classifier is used.
        config: Retry configuration. Uses defaults if None.

    Returns:
        The result of fn().

    Raises:
        The last exception encountered after retries are exhausted, or immediately
        if the error category is non-retryable.
    """
    if config is None:
        config = RetryConfig()

    last_error: Exception | None = None

    for attempt in range(config.max_retries + 1):
        try:
            return await fn()
        except Exception as e:
            last_error = e
            category = classify_error_fn(e) if classify_error_fn else _default_classify(e)

            if not config.is_retryable(category):
                logger.warning(
                    "Non-retryable error (%s) on attempt %d: %s",
                    category,
                    attempt,
                    e,
                )
                raise

            if attempt >= config.max_retries:
                logger.warning(
                    "Retryable error (%s) exhausted after %d attempts: %s",
                    category,
                    attempt,
                    e,
                )
                break

            delay = config.compute_delay(attempt)
            logger.warning(
                "Retryable error (%s) on attempt %d, retrying in %.2fs: %s",
                category,
                attempt,
                delay,
                e,
            )
            await asyncio.sleep(delay)

    assert last_error is not None
    raise last_error
