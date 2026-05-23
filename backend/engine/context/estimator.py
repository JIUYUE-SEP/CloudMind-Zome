"""Token estimator for compression trigger decisions.

Design reference: §6.4.5 Token 估算
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..message.types import Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock


class TokenEstimator:
    """Estimate token count for compression trigger decisions.

    Design reference: §6.4.5
    Uses character-based approximation with optional tiktoken for accuracy.
    """

    # Approximate characters per token
    # Chinese: ~2 chars/token, English: ~4 chars/token
    CHAR_PER_TOKEN = 4

    def estimate(self, messages: list[Message]) -> int:
        """Estimate total token count for a list of messages.

        Args:
            messages: List of Message objects.

        Returns:
            Estimated token count.
        """
        total = 0
        for msg in messages:
            # System overhead per message
            total += 4

            for block in msg.content:
                total += self._estimate_block(block)

        return total

    def _estimate_block(self, block: ContentBlock) -> int:
        """Estimate tokens for a single content block."""
        from ..message.types import TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock

        if isinstance(block, TextBlock):
            return len(block.text) // self.CHAR_PER_TOKEN
        elif isinstance(block, ThinkingBlock):
            return len(block.thinking) // self.CHAR_PER_TOKEN
        elif isinstance(block, ToolUseBlock):
            args_len = len(json.dumps(block.input)) // self.CHAR_PER_TOKEN
            return args_len + 10  # Tool call overhead
        elif isinstance(block, ToolResultBlock):
            return len(block.content) // self.CHAR_PER_TOKEN
        else:
            return 10  # Unknown block type, minimal estimate

    def estimate_for_model(self, text: str, model: str) -> int:
        """Precise estimation using the model's tokenizer.

        Falls back to character-based estimation if tiktoken unavailable.

        Args:
            text: Text to estimate.
            model: Model name for tokenizer selection.

        Returns:
            Token count.
        """
        try:
            import tiktoken

            encoding = tiktoken.encoding_for_model(model)
            return len(encoding.encode(text))
        except (ImportError, KeyError):
            return len(text) // self.CHAR_PER_TOKEN