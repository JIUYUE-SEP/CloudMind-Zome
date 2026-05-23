"""Message types for the agent framework.

Design reference: 总体设计文档 §6.3 消息模型, §6.6.3 事件类型
"""

from __future__ import annotations

import shortuuid
from dataclasses import dataclass, field
from typing import Any, Literal, Sequence


# ---------------------------------------------------------------------------
# Content blocks
# ---------------------------------------------------------------------------


@dataclass
class ContentBlock:
    """Base class for all content blocks."""

    type: str


@dataclass
class TextBlock(ContentBlock):
    """Text content."""

    type: Literal["text"] = "text"
    text: str = ""


@dataclass
class ThinkingBlock(ContentBlock):
    """LLM thinking/reasoning content (reasoning_content from providers)."""

    type: Literal["thinking"] = "thinking"
    thinking: str = ""


@dataclass
class ToolUseBlock(ContentBlock):
    """A tool call from the LLM."""

    type: Literal["tool_use"] = "tool_use"
    id: str = ""
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolResultBlock(ContentBlock):
    """Result from a tool execution."""

    type: Literal["tool_result"] = "tool_result"
    id: str = ""  # Corresponds to ToolUseBlock.id
    content: str = ""  # String content for the LLM
    truncated: bool = False  # Whether the result was truncated
    cache_path: str | None = None  # Path to full result cache file
    metadata: dict | list | None = None  # Original structured data


@dataclass
class ImageBlock(ContentBlock):
    """Image content."""

    type: Literal["image"] = "image"
    source: dict[str, Any] = field(default_factory=dict)  # URLSource or Base64Source


# ---------------------------------------------------------------------------
# Message metadata
# ---------------------------------------------------------------------------


@dataclass
class MessageMeta:
    """Framework-level metadata attached to every message.

    Design reference: §6.3.2 消息结构
    """

    id: str = field(default_factory=lambda: shortuuid.uuid())
    session_id: str = ""
    timestamp: float = field(default_factory=lambda: __import__("time").time())
    topic_id: str | None = None  # Topic for context compression
    subtopic_name: str | None = None
    branch_id: str | None = None  # DAG branch ID for parallel execution
    round: int = 0  # Conversation round number
    compressed: bool = False  # Whether this message has been compressed
    tokens_used: int = 0  # Estimated token count for this message
    source: str = ""  # "private" | "group" | "workflow"
    source_name: str = ""  # Human-readable scene name
    sender_id: str = ""  # Who sent this message (user_id / agent_id)
    sender_name: str = ""  # Display name of the sender


# ---------------------------------------------------------------------------
# Message
# ---------------------------------------------------------------------------


@dataclass
class Message:
    """Unified message model.

    Design reference: §6.3.2 - ContentBlock + 元数据, decoupled from API format.
    The Provider Transport is responsible for converting Message -> OpenAI dict.
    """

    role: Literal["user", "assistant", "system"]
    content: str | Sequence[ContentBlock] = ""
    meta: MessageMeta = field(default_factory=MessageMeta)

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def has_tool_calls(self) -> bool:
        """Check if this message contains any ToolUseBlock."""
        if isinstance(self.content, str):
            return False
        return any(isinstance(b, ToolUseBlock) for b in self.content)

    def get_tool_calls(self) -> list[ToolUseBlock]:
        """Extract all ToolUseBlock from content."""
        if isinstance(self.content, str):
            return []
        return [b for b in self.content if isinstance(b, ToolUseBlock)]

    def get_text(self) -> str:
        """Get all text content as a single string."""
        if isinstance(self.content, str):
            return self.content
        parts = []
        for b in self.content:
            if isinstance(b, TextBlock):
                parts.append(b.text)
            elif isinstance(b, ThinkingBlock):
                parts.append(b.thinking)
            elif isinstance(b, ToolResultBlock):
                parts.append(b.content)
        return "\n".join(parts)


# ---------------------------------------------------------------------------
# Message sanitization
# ---------------------------------------------------------------------------

def sanitize_tool_call_ids(messages: list[Message]) -> None:
    """Assign UUIDs to empty tool_use ids and sync matching tool_result ids.

    Walks messages in order: when a ToolUseBlock has empty id, generate a
    UUID; when a subsequent ToolResultBlock has empty id, pop from queue.
    This keeps tool_use / tool_result pairs consistent across the history.

    Modifies messages in-place.
    """
    import uuid as _uuid

    pending_ids: list[str] = []
    for msg in messages:
        if not isinstance(msg.content, list):
            continue
        for block in msg.content:
            if isinstance(block, ToolUseBlock):
                if not block.id:
                    block.id = f"call_{_uuid.uuid4().hex[:12]}"
                pending_ids.append(block.id)
            elif isinstance(block, ToolResultBlock):
                if not block.id and pending_ids:
                    block.id = pending_ids.pop(0)


# ---------------------------------------------------------------------------
# Agent events (stream output)
# ---------------------------------------------------------------------------


@dataclass
class AgentEvent:
    """Event yielded by Agent.stream().

    Design reference: §6.6.3 事件类型
    """

    type: Literal["thinking", "content", "tool_call", "tool_result", "done"]
    data: ContentBlock | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for WebSocket/HTTP responses."""
        result: dict[str, Any] = {"type": self.type}
        if self.data is not None:
            if isinstance(self.data, ContentBlock):
                result["data"] = {
                    "type": self.data.type,
                    **{
                        k: v
                        for k, v in self.data.__dict__.items()
                        if k != "type"
                    },
                }
        return result