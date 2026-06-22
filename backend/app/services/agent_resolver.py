"""Agent resolver: read agent configuration from document store.

Replaces direct SQLAlchemy Agent queries with AgentDataStore lookups.
"""

from __future__ import annotations

import logging
from typing import Any

from engine.agent.data_store import AgentDataStore

logger = logging.getLogger(__name__)


class AgentNotFoundError(Exception):
    """Raised when an agent is not found in document store."""
    pass


def get_agent_config(agent_id: str) -> dict[str, Any] | None:
    """Read agent configuration from document store.

    Returns None if agent does not exist or is deleted.
    """
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        return None
    return config


def get_agent_name(agent_id: str) -> str:
    """Get agent name from document store.

    Falls back to 'Agent' if not found.
    """
    config = get_agent_config(agent_id)
    return config.get("name", "Agent") if config else "Agent"


def get_agent_field(agent_id: str, field: str, default: Any = None) -> Any:
    """Get a specific field from agent config.

    Falls back to default if agent or field not found.
    """
    config = get_agent_config(agent_id)
    if not config:
        return default
    return config.get(field, default)


def agent_exists(agent_id: str) -> bool:
    """Check if an agent exists and is not deleted."""
    return get_agent_config(agent_id) is not None


def list_active_agents() -> list[dict[str, Any]]:
    """List all active agents from document store.

    Scans workspace directories and reads config.json files.
    """
    try:
        from app.database import WORKSPACE_ROOT
    except ImportError:
        from pathlib import Path
        WORKSPACE_ROOT = Path.home() / ".cloudmind-zome" / "workspace"

    agents = []
    if WORKSPACE_ROOT.exists():
        for agent_dir in WORKSPACE_ROOT.iterdir():
            if agent_dir.is_dir():
                store = AgentDataStore(agent_dir.name)
                config = store.read_config()
                if config and config.get("status") != "deleted":
                    agents.append(config)
    return agents


def get_agents_by_ids(agent_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Get multiple agent configs by their IDs.

    Returns a dict mapping agent_id -> config.
    Missing agents are silently skipped.
    """
    result = {}
    for aid in agent_ids:
        config = get_agent_config(aid)
        if config:
            result[aid] = config
    return result
