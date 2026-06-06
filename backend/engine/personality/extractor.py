"""Personality parameter extractor from agent text descriptions."""
from __future__ import annotations

import json
import logging
from typing import Any

from ..message.types import Message
from ..provider.transport import ChatCompletionsTransport
from ..provider.thinking.plain import PlainThinkingProfile

logger = logging.getLogger(__name__)

_PERSONALITY_PROMPT = """Analyze the following agent personality description and extract Big-5 personality scores (0.0-1.0).

Personality text:
{text}

Output ONLY valid JSON in this exact format:
{{
  "extraversion": 0.0,
  "talkativeness": 0.0,
  "reactiveness": 0.0,
  "agreeableness": 0.0,
  "emotional_stability": 0.0
}}

Scoring guidelines:
- extraversion: 1.0=outgoing/energetic, 0.0=reserved/quiet
- talkativeness: 1.0=talks a lot, 0.0=terse/minimal
- reactiveness: 1.0=quick to respond, 0.0=slow/thoughtful
- agreeableness: 1.0=cooperative, 0.0=argumentative
- emotional_stability: 1.0=calm/steady, 0.0=moody/sensitive

Rules:
1. Return ONLY the JSON object, no markdown, no explanation
2. All values between 0.0 and 1.0, 1 decimal place
3. If text is ambiguous or minimal, return neutral values (0.5)
4. Consider overall tone, not just keyword matching
"""

DEFAULT_PERSONALITY = {
    "extraversion": 0.5,
    "talkativeness": 0.5,
    "reactiveness": 0.5,
    "agreeableness": 0.5,
    "emotional_stability": 0.5,
}

DIMENSIONS = list(DEFAULT_PERSONALITY.keys())


class PersonalityExtractor:
    """Extract Big-5 personality from agent description text."""

    def __init__(self, provider_name: str, model: str, api_key: str, base_url: str):
        self.provider_name = provider_name
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    @classmethod
    def from_marker_config(cls, agent_model_config: dict) -> "PersonalityExtractor":
        """Build extractor from agent config, falling back to main provider."""
        marker_cfg = agent_model_config.get("marker") or {}
        if marker_cfg.get("provider") and marker_cfg.get("model"):
            provider_name = marker_cfg["provider"]
            model = marker_cfg["model"]
        else:
            provider_name = agent_model_config.get("provider", "deepseek")
            model = agent_model_config.get("model", "deepseek-chat")

        api_key = marker_cfg.get("api_key", "") or agent_model_config.get("api_key", "")
        base_url = marker_cfg.get("base_url", "") or agent_model_config.get("base_url", "")

        return cls(provider_name, model, api_key, base_url)

    async def analyze(self, text: str) -> dict[str, float]:
        """Analyze personality text and return Big-5 scores."""
        if not text or len(text.strip()) < 30:
            logger.warning("Personality text too short (%d chars), returning defaults", len(text))
            return {**DEFAULT_PERSONALITY}

        prompt = _PERSONALITY_PROMPT.format(text=text[:3000])

        transport = ChatCompletionsTransport(
            base_url=self.base_url,
            api_key=self.api_key,
            model=self.model,
            thinking_profile=PlainThinkingProfile(),
            timeout=15.0,
        )

        try:
            response = await transport.chat(
                messages=[Message(role="user", content=prompt)],
                tools=None,
                temperature=0.3,
            )
            return self._parse_response(response.content or "")
        except Exception as e:
            logger.warning("Personality analysis failed: %s", e)
            return {**DEFAULT_PERSONALITY}

    def _parse_response(self, text: str) -> dict[str, float]:
        """Parse LLM response, with fallback strategies."""
        text = text.strip()

        # Strategy 1: direct JSON parse
        try:
            result = json.loads(text)
            return self._normalize(result)
        except json.JSONDecodeError:
            pass

        # Strategy 2: extract JSON from markdown code block
        if "```json" in text:
            try:
                json_part = text.split("```json")[1].split("```")[0].strip()
                result = json.loads(json_part)
                return self._normalize(result)
            except Exception:
                pass

        # Strategy 3: regex extraction
        result = {}
        import re
        for dim in DIMENSIONS:
            pattern = rf'"{dim}"\s*:\s*(\d+\.?\d*)'
            match = re.search(pattern, text)
            if match:
                result[dim] = float(match.group(1))

        if result:
            return self._normalize(result)

        # Fallback
        logger.warning("Failed to parse personality response, using defaults")
        return {**DEFAULT_PERSONALITY}

    def _normalize(self, result: dict) -> dict[str, float]:
        """Ensure all dimensions exist and are clamped to 0.0-1.0."""
        out = {**DEFAULT_PERSONALITY}
        for dim in DIMENSIONS:
            val = result.get(dim)
            if isinstance(val, (int, float)):
                out[dim] = max(0.0, min(1.0, float(val)))
        return out


def build_personality_text(agent_row: Any, agent_dir: Any) -> str:
    """Assemble personality text from agent files."""
    from pathlib import Path

    parts = []

    # SOUL.md has highest priority
    soul_path = Path(agent_dir) / "SOUL.md"
    if soul_path.exists():
        parts.append(soul_path.read_text(encoding="utf-8"))

    # AGENT.md may contain behavioral clues
    agent_path = Path(agent_dir) / "AGENT.md"
    if agent_path.exists():
        text = agent_path.read_text(encoding="utf-8")
        # Only take first 1000 chars of AGENT.md (work rules, not deep personality)
        parts.append(text[:1000])

    return "\n\n".join(parts)
