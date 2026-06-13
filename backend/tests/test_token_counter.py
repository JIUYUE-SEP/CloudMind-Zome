"""Tests for token_counter."""
from __future__ import annotations

import pytest

from engine.context.token_counter import count_tokens


def test_count_tokens_empty():
    assert count_tokens("") == 0
    assert count_tokens("", model="gpt-4") == 0


def test_count_tokens_english():
    text = "Hello world"
    # tiktoken gpt-4 encoding: "Hello"=1, " world"=2  (including space)
    tiktoken_count = count_tokens(text, model="gpt-4")
    assert tiktoken_count > 0
    # Fallback heuristic should give a positive number too
    fallback_count = count_tokens(text, model="unknown-model-xyz")
    assert fallback_count > 0


def test_count_tokens_chinese():
    text = "你好世界"
    tiktoken_count = count_tokens(text, model="gpt-4")
    assert tiktoken_count > 0
    fallback_count = count_tokens(text, model="unknown-model-xyz")
    assert fallback_count > 0


def test_count_tokens_fallback_consistency():
    """Fallback heuristic must be deterministic."""
    text = "The quick brown fox jumps over the lazy dog." * 10
    c1 = count_tokens(text, model="unsupported-claude-model")
    c2 = count_tokens(text, model="unsupported-claude-model")
    assert c1 == c2


def test_count_tokens_known_models():
    """Smoke-test for models that map to known encodings."""
    text = "Test"
    for model in ["gpt-4", "gpt-3.5-turbo", "gpt-4o", "qwen-turbo", "deepseek-chat"]:
        assert count_tokens(text, model=model) > 0


def test_count_tokens_long_text():
    text = "a" * 10_000
    assert count_tokens(text, model="gpt-4") < len(text)  # tokens < chars
