"""GLM thinking profile.

Design reference: GLM_API_调用说明.md
- thinking 参数: extra_body={"enable_thinking": True}
- 思考模式 temperature: 正常
- 流式阶段标识: phase 字段
- 两套 API 体系: 通用自有 + Coding OpenAI
- reasoning_content 回传: 待验证
"""

from __future__ import annotations

from typing import Any

from .base import ThinkingProfile


class GLMThinkingProfile(ThinkingProfile):
    """GLM-specific thinking behavior."""

    def build_thinking_kwargs(self, kwargs: dict) -> dict:
        """Inject GLM thinking parameters.

        GLM uses enable_thinking instead of the thinking object format.
        """
        kwargs.setdefault("extra_body", {})
        kwargs["extra_body"]["enable_thinking"] = True
        return kwargs

    def extract(self, response: Any) -> str | None:
        """Extract reasoning_content from GLM response.

        GLM may use different field names; we try reasoning_content first.
        """
        try:
            choice = response.choices[0]
            content = getattr(choice.message, "reasoning_content", None)
            if content:
                return content
            # GLM may also embed thinking in content with phase markers
            return None
        except (IndexError, AttributeError):
            return None

    def normalize_content(self, message: dict) -> dict:
        """Handle GLM's content fallback."""
        if not message.get("content") and message.get("tool_calls"):
            message["content"] = None
        return message

    def needs_reasoning_echo(self, has_tool_calls: bool) -> bool:
        """GLM reasoning_content echo behavior: not yet fully verified.

        Defaulting to True for safety, following the same pattern as DeepSeek/MiMo.
        """
        return has_tool_calls