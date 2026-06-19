"""Agent base class with lifecycle and hooks.

Design reference: §6.6 Agent 核心抽象
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..message.types import ToolUseBlock, ToolResultBlock

if TYPE_CHECKING:
    from ..config.models import AppConfig


class AgentBase:
    """Agent base class: lifecycle + hooks.

    Design reference: §6.6.2 类结构

    Hooks:
    - on_before_tool: Before tool execution (validation, permission)
    - on_after_tool: After tool execution (result trimming, logging)
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
