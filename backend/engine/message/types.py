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
    """A tool call from the LLM.

    The ``id`` is auto-generated on instantiation if not provided,
    ensuring every tool call has a non-empty identifier.
    """

    type: Literal["tool_use"] = "tool_use"
    id: str = field(default="")
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"call_{shortuuid.uuid()[:12]}"


@dataclass
class ToolResultBlock(ContentBlock):
    """Result from a tool execution.

    ``id`` MUST match the corresponding ``ToolUseBlock.id``.
    """

    type: Literal["tool_result"] = "tool_result"
    id: str = ""  # Corresponds to ToolUseBlock.id
    content: str = ""  # String content for the LLM
    truncated: bool = False  # Whether the result was truncated
    cache_path: str | None = None  # Path to full result cache file
    metadata: dict | list | None = None  # Original structured data


@dataclass
class ImageBlock(ContentBlock):
    """Image content for multimodal models."""

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

    ``content`` may be passed as a plain ``str`` for convenience, but it is
    immediately normalised into ``[TextBlock(text=...)]`` so downstream code
    can always treat ``content`` as a sequence of blocks.
    """

    role: Literal["user", "assistant", "system"]
    content: str | Sequence[ContentBlock] = field(default_factory=list)
    meta: MessageMeta = field(default_factory=MessageMeta)

    def __post_init__(self) -> None:
        if isinstance(self.content, str):
            self.content = [TextBlock(text=self.content)]
        else:
            # Ensure we have a mutable list, not a tuple
            self.content = list(self.content)

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def text_blocks(self) -> list[TextBlock]:
        """Return all TextBlock instances."""
        return [b for b in self.content if isinstance(b, TextBlock)]

    def has_tool_calls(self) -> bool:
        """Check if this message contains any ToolUseBlock."""
        return any(isinstance(b, ToolUseBlock) for b in self.content)

    def get_tool_calls(self) -> list[ToolUseBlock]:
        """Extract all ToolUseBlock from content."""
        return [b for b in self.content if isinstance(b, ToolUseBlock)]

    def get_text(self) -> str:
        """Get all text content as a single string."""
        parts = []
        for b in self.content:
            if isinstance(b, TextBlock):
                parts.append(b.text)
            elif isinstance(b, ThinkingBlock):
                parts.append(b.thinking)
            elif isinstance(b, ToolResultBlock):
                parts.append(b.content)
        return "\n".join(parts)

    def append(self, block: ContentBlock) -> None:
        """Append a content block in-place."""
        self.content.append(block)


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
