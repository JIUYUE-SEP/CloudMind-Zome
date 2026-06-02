"""Three-tier compression trigger logic."""
from __future__ import annotations

import logging
from typing import Optional, Tuple

from ...message.types import Message
from .estimator import EstimatedTokenCounter
from .topic_context import TopicContext, TopicState, SubtopicState

logger = logging.getLogger(__name__)


class CompressionTrigger:
    def __init__(self, config: dict):
        self.config = config
        self.estimator = EstimatedTokenCounter()
        self.threshold_ratio = config.get("context_compact_threshold", 0.8)
        self.reserve_ratio = config.get("context_compact_reserve", 0.1)
        self.hard_limit = config.get("token_hard_limit", 80000)
        self.retain_delay = config.get(
            "retain_delay", {"high": 6, "normal": 3, "low": 1}
        )

    def should_compress(
        self, messages: list[Message], context_window: int
    ) -> Tuple[bool, int, int]:
        """Return (should_compress, token_count, threshold)."""
        token_count = self.estimator.estimate(messages)
        threshold = min(int(self.threshold_ratio * context_window), self.hard_limit)
        return token_count > threshold, token_count, threshold

    def get_safe_threshold(self, threshold: int) -> int:
        return int(threshold * (1 - self.reserve_ratio))

    def tier1_get_done_subtopics(
        self, topic_context: TopicContext
    ) -> list[Tuple[TopicState, SubtopicState]]:
        """Tier 1: compress done subtopics that exceed retain delay."""
        return topic_context.get_compressible_topics(self.retain_delay)

    def tier2_get_oldest_active(
        self, topic_context: TopicContext
    ) -> Optional[TopicState]:
        """Tier 2: force-close oldest active topic."""
        return topic_context.find_oldest_active_topic()

    def check_absolute_max_rounds(
        self, topic_context: TopicContext, max_rounds: int = 50
    ) -> Optional[SubtopicState]:
        """Check if any active subtopic exceeds absolute max rounds."""
        # This requires tracking round counts per subtopic
        # Implementation depends on how rounds are tracked in TopicContext
        # Placeholder: return None for now, implement when round tracking is added
        return None
