"""Error classifier: maps exceptions to FailoverReason.

Design reference: §6.9.2 错误分类与恢复策略
"""

from __future__ import annotations

from enum import Enum
from dataclasses import dataclass


class FailoverReason(Enum):
    """Why an API call failed — determines recovery strategy.

    Simplified from Hermes' 15+ reasons to 9 that matter for our 4 providers.
    """

    auth = "auth"                          # 401/403 → refresh API Key
    auth_permanent = "auth_permanent"      # Auth failed after refresh → fallback
    rate_limit = "rate_limit"              # 429 → backoff then retry
    server_error = "server_error"          # 500/502/503 → retry
    timeout = "timeout"                    # Connection/read timeout → retry
    context_overflow = "context_overflow"  # context_length exceeded → compress
    format_error = "format_error"          # 400 bad request → log and abort
    empty_response = "empty_response"      # content is empty → retry or fallback
    model_not_found = "model_not_found"   # 404 → switch model


@dataclass
class ClassifiedError:
    """Structured classification of an API error with recovery hints."""

    reason: FailoverReason
    status_code: int | None = None
    provider: str | None = None
    model: str | None = None
    message: str = ""
    retryable: bool = True
    should_compress: bool = False


def classify_error(error: Exception, provider: str = "", model: str = "") -> ClassifiedError:
    """Classify an API error and determine recovery strategy.

    Maps framework exceptions to FailoverReason with recovery hints.

    Design reference: §6.9.2 error classification taxonomy
    """
    from openai import (
        APIError,
        AuthenticationError,
        RateLimitError,
        APITimeoutError,
        BadRequestError,
        NotFoundError,
        InternalServerError,
    )

    status_code = getattr(error, "status_code", None)

    # Auth errors
    if isinstance(error, AuthenticationError):
        return ClassifiedError(
            reason=FailoverReason.auth,
            status_code=status_code or 401,
            provider=provider,
            model=model,
            message=str(error),
            retryable=False,
        )

    # Rate limit
    if isinstance(error, RateLimitError):
        return ClassifiedError(
            reason=FailoverReason.rate_limit,
            status_code=status_code or 429,
            provider=provider,
            model=model,
            message=str(error),
            retryable=True,
        )

    # Timeout
    if isinstance(error, APITimeoutError):
        return ClassifiedError(
            reason=FailoverReason.timeout,
            status_code=None,
            provider=provider,
            model=model,
            message=str(error),
            retryable=True,
        )

    # Not found
    if isinstance(error, NotFoundError):
        return ClassifiedError(
            reason=FailoverReason.model_not_found,
            status_code=status_code or 404,
            provider=provider,
            model=model,
            message=str(error),
            retryable=False,
        )

    # Bad request
    if isinstance(error, BadRequestError):
        # Check for context overflow
        error_msg = str(error).lower()
        if "context_length" in error_msg or "maximum context" in error_msg:
            return ClassifiedError(
                reason=FailoverReason.context_overflow,
                status_code=status_code or 400,
                provider=provider,
                model=model,
                message=str(error),
                retryable=True,
                should_compress=True,
            )
        return ClassifiedError(
            reason=FailoverReason.format_error,
            status_code=status_code or 400,
            provider=provider,
            model=model,
            message=str(error),
            retryable=False,
        )

    # Server error
    if isinstance(error, InternalServerError):
        return ClassifiedError(
            reason=FailoverReason.server_error,
            status_code=status_code or 500,
            provider=provider,
            model=model,
            message=str(error),
            retryable=True,
        )

    # Generic API error - try to infer from status code
    if isinstance(error, APIError):
        code = status_code or 0
        if code == 401:
            return ClassifiedError(
                reason=FailoverReason.auth, status_code=code,
                provider=provider, model=model, message=str(error), retryable=False
            )
        if code == 429:
            return ClassifiedError(
                reason=FailoverReason.rate_limit, status_code=code,
                provider=provider, model=model, message=str(error), retryable=True
            )
        if code == 404:
            return ClassifiedError(
                reason=FailoverReason.model_not_found, status_code=code,
                provider=provider, model=model, message=str(error), retryable=False
            )
        if code >= 500:
            return ClassifiedError(
                reason=FailoverReason.server_error, status_code=code,
                provider=provider, model=model, message=str(error), retryable=True
            )

    # Unknown error
    return ClassifiedError(
        reason=FailoverReason.server_error,
        status_code=status_code,
        provider=provider,
        model=model,
        message=str(error),
        retryable=True,
    )