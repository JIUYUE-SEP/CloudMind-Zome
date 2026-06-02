"""Memory system registry."""
from __future__ import annotations
from typing import TYPE_CHECKING, Type

from .base import MemorySystem
from .simple.simple_memory import SimpleMemory
from .topic_compression.topic_memory import TopicCompressionMemory

if TYPE_CHECKING:
    from ..agent.react import ReActAgent

_MEMORY_SYSTEMS: dict[str, Type[MemorySystem]] = {
    "simple": SimpleMemory,
    "topic_compression": TopicCompressionMemory,
}


def create_memory_system(name: str, agent: "ReActAgent", config: dict | None = None) -> MemorySystem:
    if name not in _MEMORY_SYSTEMS:
        raise ValueError(
            f"Unknown memory system: {name}. "
            f"Available: {list(_MEMORY_SYSTEMS.keys())}"
        )
    return _MEMORY_SYSTEMS[name](agent=agent, config=config)
