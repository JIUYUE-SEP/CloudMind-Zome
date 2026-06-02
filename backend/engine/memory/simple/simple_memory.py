"""SimpleMemory: no topic tree, no compression, no semantic recall.
Token overflow → truncate old messages brutally."""
from __future__ import annotations

from ..base import MemorySystem
from ...message.types import Message, ToolResultBlock
from ...provider.thinking.base import LLMResponse


class SimpleMemory(MemorySystem):
    """Minimal memory system. Preserves current behavior."""

    async def initialize(self) -> None:
        # Load messages from cloudmind.db agent_messages (legacy)
        agent_id = self.agent.agent_id
        store = self.agent.session_store
        if store and agent_id:
            try:
                msgs = await store.load_agent_messages(agent_id, limit=1000)
                self.agent._messages = [
                    m for m in msgs
                    if m.role != "system" or getattr(m.meta, "compressed", False)
                ]
            except Exception:
                pass

    async def shutdown(self) -> None:
        pass

    async def on_user_message(self, message: Message) -> None:
        pass

    async def before_llm(self, messages: list[Message]) -> list[Message]:
        # No memory injection. Just return as-is.
        # (mind_context, behavior guide, memory hint are handled by MessageBuilder)
        return messages

    async def on_assistant_response(self, response: LLMResponse) -> None:
        pass

    async def on_tool_result(self, result: ToolResultBlock) -> None:
        pass

    async def check_compression(self) -> bool:
        # Brutal truncation if token exceeds
        max_msgs = 500
        if self.agent.config and self.agent.config.agent:
            max_msgs = getattr(self.agent.config.agent, "max_memory_messages", 500) or 500
        if len(self.agent._messages) > max_msgs:
            trim = len(self.agent._messages) - max_msgs
            self.agent._messages = self.agent._messages[trim:]
        return True

    async def get_stats(self) -> dict:
        return {"type": "simple", "message_count": len(self.agent._messages)}
