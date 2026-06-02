"""Memory system abstract interface."""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from ..message.types import Message, ToolResultBlock

if TYPE_CHECKING:
    from ..agent.react import ReActAgent
    from ..provider.thinking.base import LLMResponse


class MemorySystem(ABC):
    """Pluggable memory system for ReActAgent."""

    def __init__(self, agent: "ReActAgent", config: dict | None = None):
        self.agent = agent
        self.config = config or {}

    @abstractmethod
    async def initialize(self) -> None:
        """Called when Agent starts. Load state, rebuild memory structures."""

    @abstractmethod
    async def shutdown(self) -> None:
        """Called when Agent stops. Persist unsaved state."""

    @abstractmethod
    async def on_user_message(self, message: Message) -> None:
        """After user message is appended to history. Topic detection here."""

    @abstractmethod
    async def before_llm(self, messages: list[Message]) -> list[Message]:
        """Before LLM call. Return messages with injected memory."""

    @abstractmethod
    async def on_assistant_response(self, response: "LLMResponse") -> None:
        """After assistant response generated."""

    @abstractmethod
    async def on_tool_result(self, result: ToolResultBlock) -> None:
        """After tool execution. Tool result pruning here."""

    @abstractmethod
    async def check_compression(self) -> bool:
        """Check if compression is needed. Return True if handled."""

    @abstractmethod
    async def get_stats(self) -> dict:
        """Return memory system stats for debugging/monitoring."""

    async def get_topic_candidates(self) -> list[dict]:
        """Return topic summary candidates for Context Pipeline L5 injection.

        Each item: {"id": str, "summary": str, "source_id": str,
                    "source_name": str, "timestamp": float, "score": float}
        Default empty — override in TopicCompressionMemory.
        """
        return []
