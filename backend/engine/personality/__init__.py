"""Personality system: extraction + prompt building."""

from .prompt_builder import personality_to_prompt
from .extractor import PersonalityExtractor, build_personality_text, DEFAULT_PERSONALITY

__all__ = ["personality_to_prompt", "PersonalityExtractor", "build_personality_text", "DEFAULT_PERSONALITY"]
