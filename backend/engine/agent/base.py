"""Agent base class with lifecycle and hooks.

Design reference: §6.6 Agent 核心抽象
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..message.types import Message, ToolUseBlock, ToolResultBlock

if TYPE_CHECKING:
    from ..provider.transport import ChatCompletionsTransport
    from ..tool.registry import ToolRegistry
    from ..config.models import AppConfig


class AgentBase:
    """Agent base class: lifecycle + hooks.

    Design reference: §6.6.2 类结构
    
    Hooks:
    - on_before_llm: Before LLM call (context injection, token budget)
    - on_after_llm: After LLM response (smart stop, reasoning_content handling)
    - on_before_tool: Before tool execution (validation, permission)
    - on_after_tool: After tool execution (result trimming, logging)
    - on_receive: Receive message from other agents (Phase 3)
    - on_send: Send message to other agents (Phase 3)
    """

    def __init__(self, name: str, session_id: str = "", config: AppConfig | None = None):
        self.name = name
        self.session_id = session_id
        self.config = config
        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Initialize session. Load history from SQLite if session_id provided."""
        self._running = True

    async def stop(self) -> None:
        """End session. Clean up resources."""
        self._running = False

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    async def on_before_llm(self, messages: list[Message]) -> list[Message]:
        """Hook: Before LLM call. Used for context injection, token budget check.
        
        Returns:
            Modified messages list (e.g. with context injected).
        """
        return messages

    async def on_after_llm(self, response: object) -> None:
        """Hook: After LLM response. Used for smart stop, reasoning_content handling."""

    async def on_before_tool(self, tool_call: ToolUseBlock) -> ToolUseBlock | None:
        """Hook: Before tool execution. Used for validation, permission.
        
        Returns:
            Modified ToolUseBlock, or None to cancel the tool call.
        """
        return tool_call

    async def on_after_tool(self, tool_result: ToolResultBlock) -> ToolResultBlock:
        """Hook: After tool execution. Used for result trimming, logging.
        
        Returns:
            Modified ToolResultBlock.
        """
        return tool_result

    # Phase 3 hooks - multi-agent communication
    async def on_receive(self, message: Message) -> None:
        """Hook: Receive message from another agent. (Phase 3)"""

    async def on_send(self, message: Message) -> None:
        """Hook: Send message to another agent. (Phase 3)"""