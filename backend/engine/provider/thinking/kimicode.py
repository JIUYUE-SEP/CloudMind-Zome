"""KimiCode thinking profile.

Design reference: KimiCode_API_调用说明.md
- thinking 参数: extra_body={"thinking": {"type": "enabled"}}
- reasoning_content 回传: tool_calls 轮次必须回传
- 思考模式 temperature: 正常
- content 为空: 偶发
- 订阅模式: 特殊计费
"""

from __future__ import annotations

from typing import Any

from .base import ThinkingProfile


class KimiCodeThinkingProfile(ThinkingProfile):
    """KimiCode-specific thinking behavior."""

    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        """Inject KimiCode thinking parameters."""
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"]["thinking"] = {"type": "enabled"}
        return kwargs

    def extract(self, response: Any) -> str | None:
        """Extract reasoning_content from KimiCode response."""
        try:
            choice = response.choices[0]
            return getattr(choice.message, "reasoning_content", None)
        except (IndexError, AttributeError):
            return None

    def normalize_content(self, message: dict) -> dict:
        """Handle KimiCode's empty content fallback."""
        if not message.get("content") and message.get("tool_calls"):
            message["content"] = None
        return message

    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        """KimiCode requires reasoning_content echo when tool_calls present."""
        return has_tool_calls