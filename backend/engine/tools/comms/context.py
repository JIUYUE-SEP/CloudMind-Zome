"""Context variables for agent-to-agent communication tools.

Since tools are registered globally but need to know which agent
is currently executing, we use a context variable (asyncio-safe).
"""

from __future__ import annotations

import contextvars

_agent_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "agent_id", default=None
)


def set_current_agent_id(agent_id: str) -> None:
    _agent_id_var.set(agent_id)


def get_current_agent_id() -> str | None:
    return _agent_id_var.get()
