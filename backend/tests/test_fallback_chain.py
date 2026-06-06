"""Tests for FallbackChain and ReActAgent fallback integration."""

from __future__ import annotations

import pytest

from engine.error.fallback import FallbackChain
from engine.error.classifier import ClassifiedError, FailoverReason


class TestFallbackChain:
    def test_current_provider_primary(self):
        fb = FallbackChain(["deepseek", "mimo", "glm"])
        assert fb.current_provider == "deepseek"

    def test_fallback_moves_to_next(self):
        fb = FallbackChain(["deepseek", "mimo", "glm"])
        next_p = fb.fallback()
        assert next_p == "mimo"
        assert fb.current_provider == "mimo"

    def test_fallback_exhausted_returns_none(self):
        fb = FallbackChain(["deepseek", "mimo"])
        fb.fallback()  # -> mimo
        assert fb.fallback() is None  # exhausted
        assert fb.current_provider == "mimo"

    def test_should_fallback_on_server_error(self):
        fb = FallbackChain(["deepseek", "mimo"])
        err = ClassifiedError(reason=FailoverReason.server_error, retryable=True)
        assert fb.should_fallback(err) is True

    def test_should_fallback_on_rate_limit(self):
        fb = FallbackChain(["deepseek", "mimo"])
        err = ClassifiedError(reason=FailoverReason.rate_limit, retryable=True)
        assert fb.should_fallback(err) is True

    def test_should_not_fallback_on_format_error(self):
        fb = FallbackChain(["deepseek", "mimo"])
        err = ClassifiedError(reason=FailoverReason.format_error, retryable=False)
        assert fb.should_fallback(err) is False

    def test_should_not_fallback_when_exhausted(self):
        fb = FallbackChain(["deepseek"])
        err = ClassifiedError(reason=FailoverReason.server_error, retryable=True)
        assert fb.should_fallback(err) is False

    def test_reset_returns_to_primary(self):
        fb = FallbackChain(["deepseek", "mimo", "glm"])
        fb.fallback()
        fb.fallback()
        assert fb.current_provider == "glm"
        fb.reset()
        assert fb.current_provider == "deepseek"


class TestReActAgentFallbackConfig:
    def test_fallback_chain_from_model_config(self):
        """ReActAgent should read fallback_chain from model_config."""
        from engine.agent.react import ReActAgent
        from unittest.mock import MagicMock

        model_cfg = {
            "fallback_chain": [
                {"provider": "deepseek", "model": "v4"},
                {"provider": "mimo", "model": "mimo-large"},
            ]
        }

        mock_transport = MagicMock()
        mock_toolkit = MagicMock()
        mock_toolkit.list_tools.return_value = []
        mock_toolkit.get_schemas.return_value = []

        agent = ReActAgent(
            name="TestAgent",
            model=mock_transport,
            toolkit=mock_toolkit,
            agent_id="test-1",
            model_config=model_cfg,
        )

        assert agent._fallback.current_provider == "deepseek"
        assert agent._fallback._chain == ["deepseek", "mimo"]

    def test_fallback_transports_mapped(self):
        """ReActAgent should store fallback_transports by provider name."""
        from engine.agent.react import ReActAgent
        from unittest.mock import MagicMock

        main_transport = MagicMock()
        mimo_transport = MagicMock()

        mock_toolkit = MagicMock()
        mock_toolkit.list_tools.return_value = []
        mock_toolkit.get_schemas.return_value = []

        agent = ReActAgent(
            name="TestAgent",
            model=main_transport,
            toolkit=mock_toolkit,
            agent_id="test-1",
            fallback_transports={"mimo": mimo_transport},
        )

        assert agent._transports["mimo"] is mimo_transport
        assert agent._current_transport is main_transport
