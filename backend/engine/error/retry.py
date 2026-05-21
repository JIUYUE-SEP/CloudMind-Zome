"""Retry strategies with exponential backoff and jitter.

Design reference: §6.9.3 重试策略详表
"""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass
class RetryConfig:
    """Retry configuration for different error types.

    Design reference: §6.9.3
    """

    # Max retry attempts by error type
    max_retries: dict[str, int] = None

    # Retry delays by error type (seconds)
    delays: dict[str, float] = None

    def __post_init__(self):
        self.max_retries = self.max_retries or {
            "rate_limit": 3,
            "server_error": 3,
            "timeout": 2,
            "auth": 1,
            "empty_response": 2,
            "context_overflow": 1,
            "format_error": 0,
            "model_not_found": 0,
            "auth_permanent": 0,
        }

        self.delays = self.delays or {
            "rate_limit": 1.0,   # base for exponential backoff
            "server_error": 1.0,
            "timeout": 5.0,      # fixed interval
            "auth": 0.0,         # no delay, just refresh
            "empty_response": 1.0,
            "context_overflow": 0.0,  # no delay, compress immediately
        }


def jittered_backoff(attempt: int, base: float = 1.0) -> float:
    """Exponential backoff with jitter to avoid thundering herd.

    Design reference: §6.9.3
    attempt=0: 1~2s
    attempt=1: 2~3s
    attempt=2: 4~5s

    Args:
        attempt: Retry attempt number (0-indexed).
        base: Base delay in seconds.

    Returns:
        Delay in seconds.
    """
    return base * (2**attempt) + random.uniform(0, base)


def get_retry_delay(reason: str, attempt: int, config: RetryConfig | None = None) -> float:
    """Get the delay before the next retry attempt.

    Args:
        reason: FailoverReason string.
        attempt: Current retry attempt (0-indexed).
        config: Retry configuration.

    Returns:
        Delay in seconds. 0 means no retry.
    """
    if config is None:
        config = RetryConfig()

    max_retries = config.max_retries.get(reason, 0)
    if attempt >= max_retries:
        return -1  # No more retries

    base = config.delays.get(reason, 1.0)

    if reason in ("timeout", "auth", "context_overflow", "empty_response"):
        # Fixed interval or no delay
        return base
    else:
        # Exponential backoff with jitter (rate_limit, server_error)
        return jittered_backoff(attempt, base)