"""Tests for FallbackChain and ReActAgent fallback integration."""

from __future__ import annotations

import pytest

from engine.error.fallback import FallbackChain, FallbackNode
from engine.error.classifier import ClassifiedError, FailoverReason


class TestFallbackChain:
    def _make_chain(self, nodes):
        return [FallbackNode(pid, mid, pid) for pid, mid in nodes]

    def test_current_provider_primary(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large"), ("glm", "glm-4")]))
        assert fb.current_provider == "deepseek"

    def test_fallback_moves_to_next(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large"), ("glm", "glm-4")]))
        next_node = fb.fallback()
        assert next_node.provider_id == "mimo"
        assert fb.current_provider == "mimo"

    def test_fallback_exhausted_returns_none(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large")]))
        fb.fallback()  # -> mimo
        assert fb.fallback() is None  # exhausted
        assert fb.current_provider == "mimo"

    def test_should_fallback_on_server_error(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large")]))
        err = ClassifiedError(reason=FailoverReason.server_error, retryable=True)
        assert fb.should_fallback(err) is True

    def test_should_fallback_on_rate_limit(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large")]))
        err = ClassifiedError(reason=FailoverReason.rate_limit, retryable=True)
        assert fb.should_fallback(err) is True

    def test_should_not_fallback_on_format_error(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large")]))
        err = ClassifiedError(reason=FailoverReason.format_error, retryable=False)
        assert fb.should_fallback(err) is False

    def test_should_not_fallback_when_exhausted(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat")]))
        err = ClassifiedError(reason=FailoverReason.server_error, retryable=True)
        assert fb.should_fallback(err) is False

    def test_reset_returns_to_primary(self):
        fb = FallbackChain(self._make_chain([("deepseek", "deepseek-chat"), ("mimo", "mimo-large"), ("glm", "glm-4")]))
        fb.fallback()
        fb.fallback()
        assert fb.current_provider == "glm"
        fb.reset()
        assert fb.current_provider == "deepseek"


class TestReActAgentFallbackConfig:
    def test_fallback_chain_from_model_config(self):
        """ReActAgent should read fallback_chain from model_config and convert to FallbackNode."""
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
        chain_ids = [n.provider_id for n in agent._fallback._chain]
        assert chain_ids == ["deepseek", "mimo"]

    def test_fallback_transports_mapped(self):
        """ReActAgent should store fallback_transports by composite provider_id::model_id key."""
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
            fallback_transports={"mimo::mimo-large": mimo_transport},
        )

        assert agent._transports["mimo::mimo-large"] is mimo_transport
        assert agent._current_transport is main_transport
