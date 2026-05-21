"""DeepSeek thinking profile.

Design reference: DeepSeek_API_调用说明.md
- thinking 参数: extra_body={"thinking": {"type": "enabled", "budget_tokens": ...}}
- reasoning_content 回传: tool_calls 轮次必须回传
- 思考模式 temperature: 被忽略
- content 为空: 常见，需要 fallback
"""

from __future__ import annotations

from typing import Any

from .base import ThinkingProfile


class DeepSeekThinkingProfile(ThinkingProfile):
    """DeepSeek-specific thinking behavior."""

    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        """Inject DeepSeek thinking parameters."""
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"]["thinking"] = {"type": "enabled"}
        # DeepSeek ignores temperature in thinking mode, but we set it anyway
        # for safety when thinking is disabled
        return kwargs

    def extract(self, response: Any) -> str | None:
        """Extract reasoning_content from DeepSeek response."""
        try:
            choice = response.choices[0]
            return getattr(choice.message, "reasoning_content", None)
        except (IndexError, AttributeError):
            return None

    def normalize_content(self, message: dict) -> dict:
        """Handle DeepSeek's empty content fallback.

        DeepSeek often returns content="" when thinking is active
        or when tool_calls are present.
        """
        if not message.get("content") and message.get("tool_calls"):
            message["content"] = None  # Use None instead of empty string
        return message

    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        """DeepSeek requires reasoning_content echo when tool_calls present."""
        return has_tool_calls