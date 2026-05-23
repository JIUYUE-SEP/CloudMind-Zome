"""SmartStop: Multi-layer stop strategy.

Design reference: §6.10 智能停止
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class StopDecision:
    """Decision from smart stop check."""

    stop: bool  # Whether to stop the loop
    reason: str | None = None  # Stop reason (max_turns / max_tokens / timeout)
    inject_hint: str | None = None  # Hint to inject for soft stops


class SmartStop:
    """Multi-layer stop strategy.

    Design reference: §6.10.2 四层停止策略
    1. LLM主动停止 (finish_reason=stop, no tool_calls)
    2. No-progress detection
    3. Loop detection
    4. Hard limits (max_turns, max_tokens, timeout)
    """

    def __init__(
        self,
        max_turns: int = 50,
        max_tokens: int = 200000,
        timeout_seconds: int = 600,
        no_progress_rounds: int = 3,
        loop_detect_rounds: int = 2,
    ):
        self.max_turns = max_turns
        self.max_tokens = max_tokens
        self.timeout_seconds = timeout_seconds
        self.no_progress_rounds = no_progress_rounds
        self.loop_detect_rounds = loop_detect_rounds

        self._turn_count: int = 0
        self._tokens_used: int = 0
        self._start_time: float = time.time()

    def reset(self) -> None:
        """Reset counters for a new conversation."""
        self._turn_count = 0
        self._tokens_used = 0
        self._start_time = time.time()

    def add_tokens(self, tokens: int) -> None:
        """Add tokens used in the current turn."""
        self._tokens_used += tokens

    def increment_turn(self) -> None:
        """Increment turn counter."""
        self._turn_count += 1

    def check(self, messages: list) -> StopDecision:
        """Check if the agent should stop.

        Evaluates stop conditions from hardest to softest:
        4. Hard limits → stop immediately
        3. Loop detection → inject hint
        2. No-progress detection → inject hint
        1. LLM decided to stop → handled by caller

        Args:
            messages: Conversation history for loop/progress detection.

        Returns:
            StopDecision indicating whether to stop and/or inject a hint.
        """
        # Layer 4: Hard limits
        if self._turn_count >= self.max_turns:
            return StopDecision(stop=True, reason="max_turns")

        if self._tokens_used >= self.max_tokens:
            return StopDecision(stop=True, reason="max_tokens")

        elapsed = time.time() - self._start_time
        if elapsed >= self.timeout_seconds:
            return StopDecision(stop=True, reason="timeout")

        # Layer 3: Loop detection
        loop_hint = self._detect_loop(messages)
        if loop_hint:
            return StopDecision(stop=False, inject_hint=loop_hint)

        # Layer 2: No-progress detection
        progress_hint = self._detect_no_progress(messages)
        if progress_hint:
            return StopDecision(stop=False, inject_hint=progress_hint)

        # Layer 1: Continue
        return StopDecision(stop=False)

    def _detect_loop(self, messages: list) -> str | None:
        """Detect if the agent is calling the same tool with the same args.

        Design reference: §6.10.2 - Layer 3
        """
        if len(messages) < self.loop_detect_rounds * 2:
            return None

        # Look at recent tool calls
        recent_calls: list[tuple[str, str]] = []
        for msg in messages[-(self.loop_detect_rounds * 2) :]:
            from ..message.types import Message

            if isinstance(msg.content, list):
                for block in msg.content:
                    from ..message.types import ToolUseBlock

                    if isinstance(block, ToolUseBlock):
                        recent_calls.append((block.name, str(block.input)))

        if len(recent_calls) < self.loop_detect_rounds:
            return None

        # Check if the last N calls are identical
        last_n = recent_calls[-self.loop_detect_rounds :]
        if len(set(last_n)) == 1:
            return (
                "你似乎在循环调用同一个工具，请换个思路或总结当前结果"
            )

        return None

    def _detect_no_progress(self, messages: list) -> str | None:
        """Detect if the agent is making no progress.

        Design reference: §6.10.2 - Layer 2
        Progress = assistant produces meaningful content OR tool results change.
        No progress = N consecutive turns where assistant content is empty/short
        AND tool results are identical or empty.
        """
        if len(messages) < self.no_progress_rounds * 2:
            return None

        from ..message.types import Message, ToolResultBlock

        recent = messages[-(self.no_progress_rounds * 2) :]
        no_progress_streak = 0

        for msg in recent:
            if not isinstance(msg, Message):
                continue

            has_progress = False

            # Assistant produced meaningful content?
            if msg.role == "assistant":
                text = msg.get_text()
                if len(text.strip()) > 30:
                    has_progress = True

            # Tool result has meaningful content?
            if msg.role == "tool":
                if isinstance(msg.content, list):
                    for block in msg.content:
                        if isinstance(block, ToolResultBlock) and block.content and len(block.content.strip()) > 10 and "Error:" not in block.content:
                            has_progress = True
                            break
                else:
                    text = msg.get_text()
                    if len(text.strip()) > 10 and "Error:" not in text:
                        has_progress = True

            if not has_progress:
                no_progress_streak += 1
            else:
                no_progress_streak = 0

        if no_progress_streak >= self.no_progress_rounds:
            return "你已连续多轮没有实质进展，请总结当前结果"

        return None