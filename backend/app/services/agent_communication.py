"""Agent communication: proactive peer-to-peer messaging.

Implements the platform-layer dispatch logic for agent-to-agent
private messages and workflow progress reporting.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..database import AsyncSessionLocal
from ..models import ActionRun, Agent
from .agent_worker import dispatch_job
from .event_bus import manager as event_manager
from .job_queue import AgentJob

logger = logging.getLogger(__name__)


async def dispatch_private_message(
    from_agent_id: str,
    to_agent_id: str,
    content: str,
    timeout: float = 120.0,
) -> str:
    """Send a private message to another Agent and return its reply text.

    Creates a Job for the target Agent with source="private" and blocks
    until the target Agent finishes processing (or timeout).
    """
    async with AsyncSessionLocal() as db:
        # Verify target agent exists
        result = await db.execute(
            select(Agent).where(
                Agent.id == to_agent_id,
                Agent.deleted_at.is_(None),
            )
        )
        target = result.scalar_one_or_none()
        if not target:
            return f"Error: target agent {to_agent_id} not found."

        result_from = await db.execute(
            select(Agent).where(Agent.id == from_agent_id)
        )
        from_agent = result_from.scalar_one_or_none()
        from_name = from_agent.name if from_agent else "Unknown"

    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()
    chunks: list[str] = []

    async def on_text_chunk(text: str) -> None:
        chunks.append(text)

    async def on_done(text: str, ok: bool) -> None:
        if not future.done():
            future.set_result("".join(chunks))

    job = AgentJob(
        source="private",
        source_id=f"agent2agent:{from_agent_id}:{to_agent_id}",
        source_name=f"来自 {from_name} 的私信",
        sender_name=from_name,
        sender_id=from_agent_id,
        content=content,
        on_text_chunk=on_text_chunk,
        on_done=on_done,
        future=future,
    )

    await dispatch_job(to_agent_id, job)

    try:
        reply = await asyncio.wait_for(future, timeout=timeout)
        return reply
    except asyncio.TimeoutError:
        return f"Agent {target.name or to_agent_id} did not reply within {timeout}s."


async def dispatch_workflow_progress(
    run_id: str,
    node_id: str,
    status: str,
    summary: str,
    sender_agent_id: str,
) -> None:
    """Update workflow run state and broadcast progress via WebSocket."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ActionRun).where(ActionRun.id == run_id)
        )
        run = result.scalar_one_or_none()
        if not run:
            logger.warning("Workflow run %s not found for progress report", run_id)
            return

        states = list(run.node_states or [])
        for s in states:
            if s.get("node_id") == node_id:
                s["status"] = status
                s["output"] = summary
                break
        else:
            states.append({
                "node_id": node_id,
                "status": status,
                "output": summary,
            })

        run.node_states = states
        await db.commit()

        total = len(states)
        completed = sum(
            1 for s in states if s.get("status") in ("completed", "failed", "stopped")
        )

        frame = {
            "type": "action.progress",
            "payload": {
                "run_id": run_id,
                "node_id": node_id,
                "node_status": status,
                "overall_progress": completed / total if total else 0,
                "current": completed,
                "total": total,
                "agent_id": sender_agent_id,
            },
        }
        try:
            await event_manager.broadcast(frame)
        except Exception:
            pass
