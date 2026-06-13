"""Tests for unified retry helper in engine.provider.retry."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from engine.provider.retry import (
    RetryConfig,
    call_with_retry,
    ErrorCategory,
)


class FakeRateLimitError(Exception):
    """Simulates a provider rate-limit response."""


class FakeTimeoutError(Exception):
    """Simulates an asyncio timeout / network timeout."""


class FakeAuthError(Exception):
    """Simulates an authentication error."""


class FakeParamError(Exception):
    """Simulates a bad-request / parameter error."""


class _AsyncIter:
    def __init__(self, items):
        self._items = items
        self._idx = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._idx >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._idx]
        self._idx += 1
        return item


@pytest.mark.asyncio
async def test_rate_limit_retries_then_succeeds():
    """RATE_LIMIT errors should be retried and eventually succeed."""
    fn = AsyncMock(side_effect=[
        FakeRateLimitError("rate limited"),
        FakeRateLimitError("rate limited"),
        FakeRateLimitError("rate limited"),
        "success",
    ])
    config = RetryConfig(max_retries=3, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        if isinstance(error, FakeRateLimitError):
            return ErrorCategory.RATE_LIMIT
        return ErrorCategory.UNKNOWN

    with patch("asyncio.sleep", new=AsyncMock()):
        result = await call_with_retry(fn, classify_error_fn=classify, config=config)

    assert result == "success"
    assert fn.call_count == 4


@pytest.mark.asyncio
async def test_timeout_is_retried():
    """TIMEOUT errors should trigger retries."""
    fn = AsyncMock(side_effect=[
        FakeTimeoutError("timeout"),
        "ok",
    ])
    config = RetryConfig(max_retries=3, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        if isinstance(error, FakeTimeoutError):
            return ErrorCategory.TIMEOUT
        return ErrorCategory.UNKNOWN

    with patch("asyncio.sleep", new=AsyncMock()):
        result = await call_with_retry(fn, classify_error_fn=classify, config=config)

    assert result == "ok"
    assert fn.call_count == 2


@pytest.mark.asyncio
async def test_auth_error_not_retried():
    """AUTH errors should fail immediately without retry."""
    fn = AsyncMock(side_effect=FakeAuthError("invalid key"))
    config = RetryConfig(max_retries=3, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        if isinstance(error, FakeAuthError):
            return ErrorCategory.AUTH
        return ErrorCategory.UNKNOWN

    with pytest.raises(FakeAuthError):
        await call_with_retry(fn, classify_error_fn=classify, config=config)

    assert fn.call_count == 1


@pytest.mark.asyncio
async def test_exhausted_retries_raise_last_error():
    """After max_retries attempts, the last exception should be raised."""
    fn = AsyncMock(side_effect=FakeRateLimitError("rate limited"))
    config = RetryConfig(max_retries=2, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        if isinstance(error, FakeRateLimitError):
            return ErrorCategory.RATE_LIMIT
        return ErrorCategory.UNKNOWN

    with patch("asyncio.sleep", new=AsyncMock()):
        with pytest.raises(FakeRateLimitError):
            await call_with_retry(fn, classify_error_fn=classify, config=config)

    assert fn.call_count == 3  # initial + 2 retries


@pytest.mark.asyncio
async def test_backoff_delay_increases_and_caps():
    """Delay should grow exponentially and not exceed max_delay."""
    config = RetryConfig(base_delay=1.0, max_delay=10.0, jitter=False)

    assert config.compute_delay(0) == 1.0
    assert config.compute_delay(1) == 2.0
    assert config.compute_delay(2) == 4.0
    assert config.compute_delay(3) == 8.0
    assert config.compute_delay(4) == 10.0  # capped
    assert config.compute_delay(10) == 10.0


@pytest.mark.asyncio
async def test_jitter_adds_randomness():
    """Jitter should add a value in [0, base_delay) to the backoff."""
    config = RetryConfig(base_delay=1.0, max_delay=10.0, jitter=True)

    delays = [config.compute_delay(0) for _ in range(50)]
    assert all(1.0 <= d < 2.0 for d in delays)
    assert len(set(delays)) > 1  # some randomness observed


@pytest.mark.asyncio
async def test_streaming_interruption_retries_and_resumes():
    """A stream that fails partway through should be retried and re-collected."""
    chunks_first_attempt = ["Hello ", "wor"]
    chunks_second_attempt = ["Hello ", "world!"]

    call_count = 0

    async def fake_stream():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            for c in chunks_first_attempt:
                yield c
            raise FakeRateLimitError("rate limited mid-stream")
        for c in chunks_second_attempt:
            yield c

    collected: list[str] = []

    async def stream_once() -> list[str]:
        return [c async for c in fake_stream()]

    config = RetryConfig(max_retries=3, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        if isinstance(error, FakeRateLimitError):
            return ErrorCategory.RATE_LIMIT
        return ErrorCategory.UNKNOWN

    with patch("asyncio.sleep", new=AsyncMock()):
        blocks = await call_with_retry(stream_once, classify_error_fn=classify, config=config)

    collected = blocks
    assert collected == chunks_second_attempt
    assert call_count == 2


@pytest.mark.asyncio
async def test_non_retryable_unknown_error_raises_immediately():
    """UNKNOWN category should be non-retryable by default."""
    fn = AsyncMock(side_effect=RuntimeError("boom"))
    config = RetryConfig(max_retries=3, base_delay=0.0, jitter=False)

    def classify(error: Exception) -> str:
        return ErrorCategory.UNKNOWN

    with pytest.raises(RuntimeError):
        await call_with_retry(fn, classify_error_fn=classify, config=config)

    assert fn.call_count == 1
