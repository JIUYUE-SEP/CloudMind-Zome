"""Tests for personality prompt builder."""
import pytest
from engine.personality.prompt_builder import personality_to_prompt


class TestPersonalityPrompt:
    def test_returns_stay_silent_instruction(self):
        p = {"extraversion": 0.9, "talkativeness": 0.8, "reactiveness": 0.7, "agreeableness": 0.6}
        prompt = personality_to_prompt(p)
        assert "stay_silent" in prompt
        assert "潜水" in prompt

    def test_no_big5_translation(self):
        p = {"extraversion": 0.1, "talkativeness": 0.2, "reactiveness": 0.3, "agreeableness": 0.5}
        prompt = personality_to_prompt(p)
        assert "内向" not in prompt
        assert "外向" not in prompt
        assert "反驳" not in prompt
        assert "stay_silent" in prompt

    def test_neutral_personality(self):
        p = {"extraversion": 0.5, "talkativeness": 0.5, "reactiveness": 0.5, "agreeableness": 0.5}
        prompt = personality_to_prompt(p)
        assert "stay_silent" in prompt

    def test_no_mention_awareness(self):
        """@mention reminder is injected independently, not via personality_to_prompt."""
        prompt = personality_to_prompt({"extraversion": 0.5})
        assert "@" not in prompt
        assert "提到你" not in prompt

    def test_empty_personality(self):
        assert personality_to_prompt(None) == ""
        assert personality_to_prompt({}) == ""
