"""Agent-scoped image generation configuration.

Since generate_image is a global tool but each Agent may have its own
image-gen provider/model, we store config keyed by agent_id.
"""

from __future__ import annotations

_agent_image_gen_cfg: dict[str, dict] = {}


def set_image_gen_config_for_agent(agent_id: str, cfg: dict) -> None:
    """Inject image_gen config for a specific agent (called by AgentWorker)."""
    _agent_image_gen_cfg[agent_id] = dict(cfg)


def get_image_gen_config_for_agent(agent_id: str | None) -> dict | None:
    """Return the agent-scoped image_gen config, or None if not set."""
    if not agent_id:
        return None
    return _agent_image_gen_cfg.get(agent_id)


def remove_image_gen_config_for_agent(agent_id: str) -> None:
    """Clean up when AgentWorker stops."""
    _agent_image_gen_cfg.pop(agent_id, None)
