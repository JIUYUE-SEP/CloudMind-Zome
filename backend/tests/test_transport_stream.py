"""Unit tests for ChatCompletionsTransport streaming with callback."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from engine.provider.transport import ChatCompletionsTransport
from engine.provider.thinking.plain import PlainThinkingProfile
from engine.message.types import Message, TextBlock


@pytest.mark.asyncio
async def test_chat_with_on_text_chunk_uses_stream():
    """When on_text_chunk is provided, chat() should yield tokens via callback."""
    transport = ChatCompletionsTransport(
        base_url="http://fake",
        api_key="fake",
        model="test",
        thinking_profile=PlainThinkingProfile(),
    )

    # Mock the underlying stream method
    async def fake_stream(*args, **kwargs):
        yield TextBlock(text="Hello ")
        yield TextBlock(text="world!")

    transport.stream = fake_stream

    chunks: list[str] = []
    def cb(text: str):
        chunks.append(text)

    response = await transport.chat(
        messages=[Message(role="user", content="hi")],
        on_text_chunk=cb,
    )

    assert "".join(chunks) == "Hello world!"
    assert response.content == "Hello world!"
    assert response.tool_calls == []
