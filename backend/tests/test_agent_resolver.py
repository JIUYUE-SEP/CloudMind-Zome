"""Tests for agent_resolver: reading agent configs from document store.

TDD approach: test the public API of agent_resolver functions.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.agent_resolver import (
    AgentNotFoundError,
    agent_exists,
    get_agent_config,
    get_agent_field,
    get_agent_name,
    get_agents_by_ids,
    list_active_agents,
)
from engine.agent.data_store import AgentDataStore


@pytest.fixture
def temp_workspace(tmp_path: Path) -> Path:
    """Provide a temporary workspace root."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.fixture
def mock_workspace(monkeypatch, tmp_path: Path):
    """Patch WORKSPACE_ROOT to use temp directory."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr(
        "app.services.agent_resolver.AgentDataStore",
        lambda agent_id, **kwargs: AgentDataStore(agent_id, workspace_root=ws),
    )
    return ws


# ------------------------------------------------------------------
# get_agent_config
# ------------------------------------------------------------------
class TestGetAgentConfig:
    def test_returns_config_when_exists(self, mock_workspace: Path) -> None:
        """get_agent_config returns config for existing agent."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent One", "provider_id": "openai"})

        config = get_agent_config("agent-1")
        assert config is not None
        assert config["name"] == "Agent One"

    def test_returns_none_when_missing(self, mock_workspace: Path) -> None:
        """get_agent_config returns None for non-existent agent."""
        assert get_agent_config("nonexistent") is None

    def test_returns_none_when_deleted(self, mock_workspace: Path) -> None:
        """get_agent_config returns None when agent status is deleted."""
        store = AgentDataStore("agent-del", workspace_root=mock_workspace)
        store.write_config({"name": "Deleted", "status": "deleted"})
        assert get_agent_config("agent-del") is None


# ------------------------------------------------------------------
# get_agent_name
# ------------------------------------------------------------------
class TestGetAgentName:
    def test_returns_name(self, mock_workspace: Path) -> None:
        """get_agent_name returns the agent's name."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "My Agent"})
        assert get_agent_name("agent-1") == "My Agent"

    def test_fallback_to_default(self, mock_workspace: Path) -> None:
        """get_agent_name falls back to 'Agent' when not found."""
        assert get_agent_name("missing") == "Agent"

    def test_fallback_when_no_name_field(self, mock_workspace: Path) -> None:
        """get_agent_name falls back when config exists but has no name."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"provider_id": "openai"})
        assert get_agent_name("agent-1") == "Agent"


# ------------------------------------------------------------------
# get_agent_field
# ------------------------------------------------------------------
class TestGetAgentField:
    def test_returns_existing_field(self, mock_workspace: Path) -> None:
        """get_agent_field returns value for existing field."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"provider_id": "openai", "model_id": "gpt-4"})
        assert get_agent_field("agent-1", "provider_id") == "openai"

    def test_returns_default_when_field_missing(self, mock_workspace: Path) -> None:
        """get_agent_field returns default when field is missing."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent"})
        assert get_agent_field("agent-1", "provider_id", "default") == "default"

    def test_returns_default_when_agent_missing(self, mock_workspace: Path) -> None:
        """get_agent_field returns default when agent does not exist."""
        assert get_agent_field("missing", "field", "fallback") == "fallback"

    def test_none_default(self, mock_workspace: Path) -> None:
        """get_agent_field returns None when no default provided and missing."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent"})
        assert get_agent_field("agent-1", "missing_field") is None


# ------------------------------------------------------------------
# agent_exists
# ------------------------------------------------------------------
class TestAgentExists:
    def test_true_when_exists(self, mock_workspace: Path) -> None:
        """agent_exists returns True for existing agent."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent"})
        assert agent_exists("agent-1") is True

    def test_false_when_missing(self, mock_workspace: Path) -> None:
        """agent_exists returns False for non-existent agent."""
        assert agent_exists("missing") is False

    def test_false_when_deleted(self, mock_workspace: Path) -> None:
        """agent_exists returns False when agent is deleted."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent", "status": "deleted"})
        assert agent_exists("agent-1") is False


# ------------------------------------------------------------------
# list_active_agents
# ------------------------------------------------------------------
class TestListActiveAgents:
    def test_lists_only_active(self, mock_workspace: Path) -> None:
        """list_active_agents returns only non-deleted agents."""
        store1 = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store1.write_config({"name": "Active Agent", "status": "active"})

        store2 = AgentDataStore("agent-2", workspace_root=mock_workspace)
        store2.write_config({"name": "Deleted Agent", "status": "deleted"})

        agents = list_active_agents()
        assert len(agents) == 1
        assert agents[0]["name"] == "Active Agent"

    def test_empty_when_no_agents(self, mock_workspace: Path) -> None:
        """list_active_agents returns empty list when workspace is empty."""
        assert list_active_agents() == []

    def test_ignores_non_directory_files(self, mock_workspace: Path) -> None:
        """list_active_agents ignores files in workspace root."""
        (mock_workspace / "not_a_dir.txt").write_text("hello")
        assert list_active_agents() == []


# ------------------------------------------------------------------
# get_agents_by_ids
# ------------------------------------------------------------------
class TestGetAgentsByIds:
    def test_returns_existing_agents(self, mock_workspace: Path) -> None:
        """get_agents_by_ids returns configs for existing agents."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent One"})

        result = get_agents_by_ids(["agent-1"])
        assert "agent-1" in result
        assert result["agent-1"]["name"] == "Agent One"

    def test_skips_missing_agents(self, mock_workspace: Path) -> None:
        """get_agents_by_ids silently skips missing agents."""
        result = get_agents_by_ids(["missing"])
        assert "missing" not in result
        assert result == {}

    def test_mixed_ids(self, mock_workspace: Path) -> None:
        """get_agents_by_ids handles mix of existing and missing."""
        store = AgentDataStore("agent-1", workspace_root=mock_workspace)
        store.write_config({"name": "Agent One"})

        result = get_agents_by_ids(["agent-1", "missing"])
        assert len(result) == 1
        assert "agent-1" in result
