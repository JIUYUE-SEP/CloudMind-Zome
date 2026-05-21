"""Skill decay: auto-remove unused skills.

Design reference: §6.15.5 衰减淘汰
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)


@dataclass
class SkillEntry:
    """A skill with usage tracking."""

    name: str
    func: Callable
    call_count: int = 0
    last_called_at: float = 0.0
    created_at: float = 0.0
    cold: bool = False


class SkillDecay:
    """Manages skill lifecycle: cooldown and expiry.

    Design reference: §6.15.5
    - 30 days unused → cold
    - 60 days unused → removed
    """

    COOLDOWN_DAYS = 30
    EXPIRY_DAYS = 60

    def __init__(self, registry: Any):
        self.registry = registry
        self._skills: dict[str, SkillEntry] = {}

    def register(self, name: str, func: Callable) -> SkillEntry:
        """Register a new skill."""
        entry = SkillEntry(
            name=name,
            func=func,
            created_at=time.time(),
            last_called_at=time.time(),
        )
        self._skills[name] = entry
        return entry

    def record_call(self, name: str) -> None:
        """Record that a skill was called."""
        if name in self._skills:
            self._skills[name].call_count += 1
            self._skills[name].last_called_at = time.time()
            self._skills[name].cold = False

    def check_decay(self) -> list[str]:
        """Check all skills for decay. Returns list of removed skill names."""
        now = time.time()
        removed = []

        for name, skill in list(self._skills.items()):
            days_since = (now - skill.last_called_at) / 86400

            if days_since > self.EXPIRY_DAYS:
                # Remove
                logger.info("Skill %s expired after %.0f days, removing", name, days_since)
                del self._skills[name]
                # Also remove from tool registry
                self.registry.remove(name)
                removed.append(name)

            elif days_since > self.COOLDOWN_DAYS and not skill.cold:
                # Mark as cold
                logger.info("Skill %s cooling down after %.0f days", name, days_since)
                skill.cold = True
                # Update schema description
                self._update_cold_description(name)

        return removed

    def _update_cold_description(self, name: str) -> None:
        """Mark skill schema as cold."""
        tool_info = self.registry.get_tool(name)
        if tool_info:
            schema = tool_info.get("schema", {})
            func = schema.get("function", {})
            desc = func.get("description", "")
            if "(低频技能" not in desc:
                func["description"] = desc + " (低频技能，可能即将注销)"

    def get_stats(self) -> dict[str, dict]:
        """Get usage stats for all skills."""
        now = time.time()
        return {
            name: {
                "call_count": s.call_count,
                "days_since_call": (now - s.last_called_at) / 86400,
                "cold": s.cold,
            }
            for name, s in self._skills.items()
        }
