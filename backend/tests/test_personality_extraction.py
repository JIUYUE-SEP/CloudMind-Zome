"""Tests for personality extraction from SOUL.md (not personality_prompt)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from engine.personality.extractor import (
    build_personality_text,
    PersonalityExtractor,
    DEFAULT_PERSONALITY,
    DIMENSIONS,
)


class TestBuildPersonalityText:
    def test_reads_soul_md(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            soul = Path(tmpdir) / "SOUL.md"
            soul.write_text("I am a curious explorer.", encoding="utf-8")
            agent = MagicMock()
            # No personality_prompt field
            del agent.personality_prompt
            text = build_personality_text(agent, tmpdir)
            assert "curious explorer" in text

    def test_ignores_missing_personality_prompt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            soul = Path(tmpdir) / "SOUL.md"
            soul.write_text("Brave and kind.", encoding="utf-8")
            agent = MagicMock()
            # getattr fallback returns None, should not crash
            text = build_personality_text(agent, tmpdir)
            assert "Brave and kind" in text
            assert "personality_prompt" not in text.lower()

    def test_reads_agent_md_first_1000_chars(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            soul = Path(tmpdir) / "SOUL.md"
            soul.write_text("SOUL content", encoding="utf-8")
            agent_md = Path(tmpdir) / "AGENT.md"
            agent_md.write_text("A" * 2000, encoding="utf-8")
            agent = MagicMock()
            text = build_personality_text(agent, tmpdir)
            assert "SOUL content" in text
            assert len(text.split("AGENT.md")[0]) < 1500  # truncated

    def test_empty_when_no_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            agent = MagicMock()
            text = build_personality_text(agent, tmpdir)
            assert text == ""


class TestPersonalityExtractorParse:
    def test_parse_valid_json(self):
        extractor = PersonalityExtractor("deepseek", "mock", "key", "http://x")
        result = extractor._parse_response(
            '{"extraversion": 0.8, "talkativeness": 0.7, "reactiveness": 0.6, '
            '"agreeableness": 0.5, "emotional_stability": 0.4}'
        )
        assert result["extraversion"] == 0.8
        assert result["talkativeness"] == 0.7

    def test_parse_json_code_block(self):
        extractor = PersonalityExtractor("deepseek", "mock", "key", "http://x")
        result = extractor._parse_response(
            '```json\n{"extraversion": 0.3}\n```'
        )
        assert result["extraversion"] == 0.3

    def test_parse_regex_fallback(self):
        extractor = PersonalityExtractor("deepseek", "mock", "key", "http://x")
        result = extractor._parse_response(
            'some text "extraversion": 0.2 more text'
        )
        assert result["extraversion"] == 0.2

    def test_parse_unparseable_returns_defaults(self):
        extractor = PersonalityExtractor("deepseek", "mock", "key", "http://x")
        result = extractor._parse_response("not json at all")
        assert result == DEFAULT_PERSONALITY

    def test_normalize_clamps_values(self):
        extractor = PersonalityExtractor("deepseek", "mock", "key", "http://x")
        result = extractor._normalize({
            "extraversion": 1.5,
            "talkativeness": -0.2,
        })
        assert result["extraversion"] == 1.0
        assert result["talkativeness"] == 0.0
        assert result["agreeableness"] == DEFAULT_PERSONALITY["agreeableness"]
