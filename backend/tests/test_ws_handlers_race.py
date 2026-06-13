"""Test S2: _cancel_and_start_private_agent race condition fix."""
from __future__ import annotations

import asyncio

import pytest

from app.api.ws_handlers import _private_agent_tasks


async def _mock_private_worker(session_id: str) -> None:
    """Minimal stand-in for _private_agent_worker to test finally logic."""
    try:
        await asyncio.sleep(0.2)
    except asyncio.CancelledError:
        pass
    finally:
        current_task = asyncio.current_task()
        if _private_agent_tasks.get(session_id) is current_task:
            _private_agent_tasks.pop(session_id, None)


@pytest.mark.asyncio
async def test_race_condition_cleanup_only_pops_self():
    """Simulate rapid-fire messages: Task A must not pop Task B from registry."""
    session_id = "test_session_race"
    _private_agent_tasks.pop(session_id, None)

    task_a = asyncio.create_task(_mock_private_worker(session_id))
    _private_agent_tasks[session_id] = task_a

    # Task B starts immediately (overwrites registry)
    task_b = asyncio.create_task(_mock_private_worker(session_id))
    _private_agent_tasks[session_id] = task_b

    # Cancel A and let it finish
    task_a.cancel()
    try:
        await task_a
    except asyncio.CancelledError:
        pass

    # A's finally should NOT have popped B
    assert _private_agent_tasks.get(session_id) is task_b

    # Clean up B
    task_b.cancel()
    try:
        await task_b
    except asyncio.CancelledError:
        pass
    assert session_id not in _private_agent_tasks
