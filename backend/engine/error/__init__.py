"""Error classification and recovery.

Design reference: §6.9 错误恢复
"""

from .classifier import FailoverReason, ClassifiedError, classify_error
from .retry import jittered_backoff, RetryConfig
from .fallback import FallbackChain

__all__ = [
    "FailoverReason",
    "ClassifiedError",
    "classify_error",
    "jittered_backoff",
    "RetryConfig",
    "FallbackChain",
]