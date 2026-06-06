"""Unit tests for ChatCompletionsTransport streaming."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from engine.provider.transport import ChatCompletionsTransport
from engine.provider.thinking.plain import PlainThinkingProfile
from engine.message.types import Message, TextBlock


class _AsyncIter:
    """Helper to mock an async iterable for OpenAI stream response."""
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
async def test_stream_yields_text_blocks():
    """stream() should yield TextBlock chunks from the API."""
    transport = ChatCompletionsTransport(
        base_url="http://fake",
        api_key="fake",
        model="test",
        thinking_profile=PlainThinkingProfile(),
    )

    # Mock the underlying OpenAI client
    mock_chunk1 = MagicMock()
    mock_chunk1.choices = [MagicMock()]
    mock_chunk1.choices[0].delta.content = "Hello "
    mock_chunk1.choices[0].delta.reasoning_content = None
    mock_chunk1.choices[0].delta.tool_calls = None

    mock_chunk2 = MagicMock()
    mock_chunk2.choices = [MagicMock()]
    mock_chunk2.choices[0].delta.content = "world!"
    mock_chunk2.choices[0].delta.reasoning_content = None
    mock_chunk2.choices[0].delta.tool_calls = None

    mock_response = _AsyncIter([mock_chunk1, mock_chunk2])
    transport._client.chat.completions.create = AsyncMock(return_value=mock_response)

    chunks = []
    async for block in transport.stream(messages=[Message(role="user", content="hi")]):
        if isinstance(block, TextBlock):
            chunks.append(block.text)

    assert "".join(chunks) == "Hello world!"
