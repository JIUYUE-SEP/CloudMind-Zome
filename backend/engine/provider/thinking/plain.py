"""Plain thinking profile for non-reasoning assistant models.

Used by the assistant model (memory compression, relevance filtering, etc.)
which does not need reasoning content support.
"""

from __future__ import annotations

from typing import Any

from .base import ThinkingProfile


class PlainThinkingProfile(ThinkingProfile):
    """No-op thinking profile."""

    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        return kwargs

    def extract(self, response: Any) -> str | None:
        return None

    def normalize_content(self, message: dict) -> dict:
        return message

    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        return False
