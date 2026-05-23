"""Agent communication tools: peer-to-peer private messages.

These tools allow an Agent to proactively reach out to another Agent
outside of the normal user-driven chat flow.
"""

from __future__ import annotations

import asyncio
import logging

from ...tool.registry import tool_registry
from .context import get_current_agent_id
from .dispatchers import get_send_private_message, get_report_workflow_progress

logger = logging.getLogger(__name__)


@tool_registry.register(toolset="comms", max_result_chars=8000, safe_to_parallel=False)
async def send_private_message(target_agent_id: str, content: str) -> str:
    """Send a private message to another Agent and wait for its reply.

    Use this when you need to consult, delegate, or notify another Agent
    privately without involving the user or the group chat.

    Args:
        target_agent_id: The ID of the Agent you want to message.
        content: The message content. Be concise and clear.
    """
    sender_id = get_current_agent_id()
    if not sender_id:
        return "Error: sender context not available."

    if sender_id == target_agent_id:
        return "Error: cannot send message to yourself."

    dispatch = get_send_private_message()
    if dispatch is None:
        return "Error: communication dispatcher not registered (platform layer not initialized)."

    try:
        reply = await dispatch(sender_id, target_agent_id, content)
        return reply
    except asyncio.TimeoutError:
        return f"Error: Agent {target_agent_id} did not reply in time."
    except Exception as e:
        logger.exception("send_private_message failed")
        return f"Error: failed to send message: {e}"


@tool_registry.register(toolset="comms", max_result_chars=4000, safe_to_parallel=True)
async def report_workflow_progress(run_id: str, node_id: str, status: str, summary: str) -> str:
    """Report the completion status of a workflow node.

    Use this after finishing a workflow node so the system can update
    progress and notify the user.

    Args:
        run_id: The workflow run ID.
        node_id: The current node ID.
        status: "completed" | "failed" | "partial".
        summary: A brief summary of what was accomplished.
    """
    sender_id = get_current_agent_id()
    if not sender_id:
        return "Error: sender context not available."

    report = get_report_workflow_progress()
    if report is None:
        return "Error: progress dispatcher not registered (platform layer not initialized)."

    try:
        await report(run_id, node_id, status, summary, sender_id)
        return f"Progress reported: node {node_id} is {status}."
    except Exception as e:
        logger.exception("report_workflow_progress failed")
        return f"Error: {e}"
