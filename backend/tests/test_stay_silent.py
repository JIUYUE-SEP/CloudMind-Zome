"""Tests for stay_silent tool handling in ReActAgent."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, AsyncMock

from engine.agent.react import ReActAgent
from engine.message.types import (
    AgentEvent,
    TextBlock,
    ToolUseBlock,
    ToolResultBlock,
)


@pytest.fixture
def mock_toolkit():
    toolkit = MagicMock()
    toolkit.list_tools.return_value = ["stay_silent"]
    toolkit.get_schemas.return_value = []
    toolkit.get_tool.return_value = {"safe_to_parallel": True}
    return toolkit


@pytest.fixture
def mock_transport():
    transport = MagicMock()
    return transport


@pytest.mark.asyncio
async def test_stay_silent_yields_done_and_no_content(mock_transport, mock_toolkit):
    """When LLM calls stay_silent, stream should yield done with empty content."""

    async def fake_stream(*args, **kwargs):
        yield ToolUseBlock(id="call_1", name="stay_silent", input={"reason": "not interested"})

    mock_transport.stream = fake_stream

    agent = ReActAgent(
        name="TestAgent",
        model=mock_transport,
        toolkit=mock_toolkit,
        agent_id="test-agent",
    )

    # Mock toolkit.execute to return stay_silent marker
    async def fake_execute(name, arguments):
        if name == "stay_silent":
            return "[stay_silent]"
        return "ok"

    mock_toolkit.execute = fake_execute

    # Mock _save_message to avoid DB writes
    agent._save_message = AsyncMock()
    agent._load_history = AsyncMock()
    agent._load_mind_files = MagicMock(return_value="")
    agent.memory_system = MagicMock()
    agent.memory_system.initialize = AsyncMock()
    agent.memory_system.on_user_message = AsyncMock()
    agent.memory_system.check_compression = AsyncMock()
    agent.memory_system.on_assistant_response = AsyncMock()

    events = []
    async for event in agent.stream(
        user_message="any message",
        source="group",
        source_id="sess-1",
    ):
        events.append(event)

    # Should have tool_call event and done event
    assert any(e.type == "tool_call" for e in events)
    assert any(e.type == "done" for e in events)

    # No content events
    content_events = [e for e in events if e.type == "content"]
    assert len(content_events) == 0


@pytest.mark.asyncio
async def test_stay_silent_detected_in_tool_result(mock_transport, mock_toolkit):
    """_is_stay_silent should detect stay_silent by tool name or marker string."""

    async def fake_stream(*args, **kwargs):
        yield ToolUseBlock(id="call_1", name="stay_silent", input={})

    mock_transport.stream = fake_stream

    agent = ReActAgent(
        name="TestAgent",
        model=mock_transport,
        toolkit=mock_toolkit,
        agent_id="test-agent",
    )

    async def fake_execute(name, arguments):
        return "[stay_silent]"

    mock_toolkit.execute = fake_execute

    agent._save_message = AsyncMock()
    agent._load_history = AsyncMock()
    agent._load_mind_files = MagicMock(return_value="")
    agent.memory_system = MagicMock()
    agent.memory_system.initialize = AsyncMock()
    agent.memory_system.on_user_message = AsyncMock()
    agent.memory_system.check_compression = AsyncMock()
    agent.memory_system.on_assistant_response = AsyncMock()

    events = []
    async for event in agent.stream(
        user_message="hello",
        source="group",
        source_id="sess-2",
    ):
        events.append(event)

    # After stay_silent, loop should end immediately without more LLM calls
    done_events = [e for e in events if e.type == "done"]
    assert len(done_events) == 1
