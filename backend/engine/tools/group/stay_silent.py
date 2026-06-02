"""stay_silent tool: allows an agent to explicitly decline replying in group chat."""
from __future__ import annotations
import logging
from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)


@tool_registry.register(toolset="group", safe_to_parallel=True)
def stay_silent(reason: str = "") -> str:
    """Choose to stay silent in the current group conversation.

    Call this tool when you decide NOT to reply to the current message.
    This is a normal social behavior — you don't have to respond to everything.

    Examples of when to stay silent:
    - The topic doesn't interest you
    - You have nothing meaningful to add
    - You're feeling quiet today (low extraversion)
    - The conversation is between others and doesn't involve you
    - You were not mentioned and the topic is outside your expertise

    Args:
        reason: Optional brief reason for staying silent (for logging only).
    """
    logger.info("Agent chose to stay_silent. Reason: %s", reason or "(none)")
    return "[stay_silent]"
