"""Agent Job queue: dataclass and global registry.

Every Agent has exactly one asyncio.Queue. All dispatchers put Jobs into
that queue; the Agent's Worker Task consumes them FIFO.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict


# ------------------------------------------------------------------
# Job
# ------------------------------------------------------------------
@dataclass
class AgentJob:
    """A single unit of work for an Agent Worker."""

    job_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source: str = ""          # "private" | "group" | "workflow"
    source_id: str = ""       # session_id | group_session_id | action_run_id
    source_name: str = ""     # display name of the scene
    sender_id: str = ""       # user_id / agent_id / "workflow_system"
    sender_name: str = ""     # "调度员" / "Beta" / "工作流引擎"
    content: str = ""         # message content / workflow instruction
    content_type: str = "text"  # "text" | "image" | "file"

    # Ingest-only mode: write message to memory without generating reply
    # Used in group chat Step 1 — ALL agents get the message, then LLM decides
    ingest_only: bool = False

    # Group chat: whether this agent was @mentioned
    is_mentioned: bool = False

    # Optional: user can set a display name override for this job
    sender_display: str = ""

    # Stop signal (private chat only)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)

    # Callbacks -------------------------------------------------------------
    # on_chunk(text)      -> called for every chunk (text/thinking/tool_call, may include prefixes)
    # on_text_chunk(text) -> called ONLY for text content, no prefixes
    # on_done(text, ok)    -> called once when Job finishes (or fails)
    on_chunk: Callable[[str], Awaitable[None]] = field(
        default_factory=lambda: (lambda _t: asyncio.sleep(0))
    )
    on_text_chunk: Callable[[str], Awaitable[None]] = field(
        default_factory=lambda: (lambda _t: asyncio.sleep(0))
    )
    on_done: Callable[[str, bool], Awaitable[None]] = field(
        default_factory=lambda: (lambda _t, _ok: asyncio.sleep(0))
    )

    # For workflow / synchronous callers: an asyncio.Future is set
    # when the Job completes so the caller can await it.
    future: asyncio.Future | None = None


# ------------------------------------------------------------------
# Global queue registry
# ------------------------------------------------------------------
_queues: Dict[str, asyncio.Queue] = {}


def get_queue(agent_id: str) -> asyncio.Queue:
    """Return (or create) the FIFO queue for *agent_id*."""
    if agent_id not in _queues:
        _queues[agent_id] = asyncio.Queue()
    return _queues[agent_id]


def ensure_queue(agent_id: str) -> asyncio.Queue:
    """Alias for get_queue."""
    return get_queue(agent_id)
