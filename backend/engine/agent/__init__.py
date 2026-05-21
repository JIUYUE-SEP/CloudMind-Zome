"""Agent core: AgentBase and ReActAgent.

Design reference: §6.6 Agent 核心抽象
"""

from .base import AgentBase
from .react import ReActAgent
from .events import AgentEvent
from .stop import SmartStop, StopDecision
from .coordinator import AgentCoordinator
from .pool import AgentPool

__all__ = [
    "AgentBase",
    "ReActAgent",
    "AgentEvent",
    "SmartStop",
    "StopDecision",
    "AgentCoordinator",
    "AgentPool",
]