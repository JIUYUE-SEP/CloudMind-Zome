"""Lightweight token estimator for compression decisions."""
from __future__ import annotations

from ...message.types import Message


class EstimatedTokenCounter:
    """Approximate token count. Performance-first, not exact."""

    def estimate(self, messages: list[Message]) -> int:
        total = 0
        for msg in messages:
            text = msg.get_text() if hasattr(msg, "get_text") else str(msg.content)
            # Chinese chars: ~1.5 tokens each, English: ~0.25 tokens per char
            cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
            en = len(text) - cn
            total += int(cn * 1.5 + en * 0.25)
        return max(total, 1)

    def count_messages(self, messages: list[Message]) -> int:
        return self.estimate(messages)
