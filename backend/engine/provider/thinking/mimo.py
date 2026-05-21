"""MiMo thinking profile.

Design reference: MiMo_API_调用说明.md
- thinking 参数: extra_body={"thinking": {"type": "enabled"}}
- reasoning_content 回传: tool_calls 轮次必须回传
- 思考模式 temperature: 强制覆盖 1.0
- content 为空: 偶发
"""

from __future__ import annotations

from typing import Any

from .base import ThinkingProfile


class MiMoThinkingProfile(ThinkingProfile):
    """MiMo-specific thinking behavior."""

    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        """Inject MiMo thinking parameters and override temperature."""
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"]["thinking"] = {"type": "enabled"}
        # MiMo forces temperature to 1.0 in thinking mode
        kwargs["temperature"] = 1.0
        return kwargs

    def extract(self, response: Any) -> str | None:
        """Extract reasoning_content from MiMo response."""
        try:
            choice = response.choices[0]
            return getattr(choice.message, "reasoning_content", None)
        except (IndexError, AttributeError):
            return None

    def normalize_content(self, message: dict) -> dict:
        """Handle MiMo's empty content fallback."""
        if not message.get("content") and message.get("tool_calls"):
            message["content"] = None
        return message

    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        """MiMo requires reasoning_content echo when tool_calls present."""
        return has_tool_calls