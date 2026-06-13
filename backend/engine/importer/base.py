"""Import adapter base class for importing conversation history from external platforms."""
from __future__ import annotations

from abc import ABC, abstractmethod


class ImportAdapter(ABC):
    """Base adapter for importing conversation history.

    Subclasses must implement:
      - platform_name(): return a unique string identifier.
      - parse(file_content): convert raw file bytes into a list of unified messages.

    Unified message format (dict):
    {
        "role": "user" | "assistant" | "system" | "tool",
        "content": str,              # plain text content
        "tool_calls": str | None,    # JSON string of tool_use list
        "reasoning_content": str | None,
        "tool_call_id": str | None,
        "tool_name": str | None,
        "sender_name": str,
        "timestamp": str,            # ISO 8601
        "message_uuid": str,
    }
    """

    @abstractmethod
    def platform_name(self) -> str:
        """Return the platform name, e.g. 'qwenpaw'."""

    @abstractmethod
    def parse(self, file_content: bytes) -> list[dict]:
        """Parse raw file bytes and return a list of unified message dicts."""
