"""Tests for group chat dispatch: all agents get stream jobs, no router pre-filter."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from app.api.ws_handlers import _is_agent_mentioned


class TestIsAgentMentioned:
    def test_match_name(self):
        agent = MagicMock()
        agent.name = "维克托"
        agent.codename = "victor"
        agent.aliases = []
        assert _is_agent_mentioned(agent, {"维克托"}) is True

    def test_match_codename(self):
        agent = MagicMock()
        agent.name = "维克托"
        agent.codename = "victor"
        agent.aliases = []
        assert _is_agent_mentioned(agent, {"victor"}) is True

    def test_match_alias(self):
        agent = MagicMock()
        agent.name = "维克托"
        agent.codename = "victor"
        agent.aliases = ["老维", "Vic"]
        assert _is_agent_mentioned(agent, {"老维"}) is True
        assert _is_agent_mentioned(agent, {"vic"}) is True  # case-insensitive

    def test_no_match(self):
        agent = MagicMock()
        agent.name = "维克托"
        agent.codename = "victor"
        agent.aliases = []
        assert _is_agent_mentioned(agent, {"艾拉"}) is False

    def test_none_agent_returns_false(self):
        assert _is_agent_mentioned(None, {" anyone"}) is False

    def test_case_insensitive(self):
        agent = MagicMock()
        agent.name = "A"
        agent.codename = "Alpha"
        agent.aliases = []
        assert _is_agent_mentioned(agent, {"alpha"}) is True
        assert _is_agent_mentioned(agent, {"ALPHA"}) is False  # we lower only query side
