"""Skill pattern detector: identifies repeated tool call sequences.

Design reference: §6.15.2 技能进化路径
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCallRecord:
    """A single tool call observation."""

    name: str
    arguments: dict[str, Any]
    timestamp: float = 0.0


@dataclass
class SequencePattern:
    """Detected repeating tool call sequence."""

    sequence: list[str]  # Tool names in order
    count: int = 0
    first_seen: float = 0.0
    last_seen: float = 0.0
    param_patterns: dict[int, dict[str, Any]] = field(default_factory=dict)


class PatternDetector:
    """Detects repeated tool call sequences.

    Design reference: §6.15.1 - Trigger: same sequence 5 times
    """

    TRIGGER_THRESHOLD = 5

    def __init__(self):
        self._history: list[ToolCallRecord] = []
        self._sequence_counts: dict[tuple[str, ...], int] = defaultdict(int)
        self._detected_patterns: dict[tuple[str, ...], SequencePattern] = {}

    def record(self, tool_calls: list[dict[str, Any]], timestamp: float = 0.0) -> None:
        """Record a set of tool calls from one turn."""
        for tc in tool_calls:
            self._history.append(
                ToolCallRecord(
                    name=tc["name"],
                    arguments=tc.get("arguments", {}),
                    timestamp=timestamp,
                )
            )

    def detect(self, sequence_length: int = 3) -> SequencePattern | None:
        """Detect if any sequence has repeated TRIGGER_THRESHOLD times.

        Args:
            sequence_length: Length of sequence to look for.

        Returns:
            SequencePattern if a trigger is met, None otherwise.
        """
        if len(self._history) < sequence_length * self.TRIGGER_THRESHOLD:
            return None

        # Look for repeated sequences
        for i in range(len(self._history) - sequence_length + 1):
            seq = tuple(tc.name for tc in self._history[i : i + sequence_length])
            self._sequence_counts[seq] += 1

            if self._sequence_counts[seq] >= self.TRIGGER_THRESHOLD:
                if seq not in self._detected_patterns:
                    pattern = SequencePattern(
                        sequence=list(seq),
                        count=self._sequence_counts[seq],
                    )
                    self._detected_patterns[seq] = pattern
                    return pattern

        return None

    def reset(self) -> None:
        """Clear detection history."""
        self._history.clear()
        self._sequence_counts.clear()
        self._detected_patterns.clear()
