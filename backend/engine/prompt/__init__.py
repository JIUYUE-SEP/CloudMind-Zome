"""Prompt builder: identity / workspace / session three-layer system.

Design reference: §6.7 Prompt 系统
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from ..config.models import AppConfig


class PromptBuilder:
    """Three-layer prompt assembly.

    Design reference: §6.7.2
    - identity: Agent persona, core behavior (cached, built once)
    - workspace: Project context, tool guidance, env hints (rebuilt on tool change)
    - session: Topic summaries, memory injection, timestamp (rebuilt every turn)
    """

    def __init__(self, config: AppConfig | None = None):
        self.config = config or AppConfig()
        self._identity_cache: str | None = None
        self._workspace_cache: str | None = None
        self._workspace_toolset_hash: int | None = None

    def build(self, session_context: str | None = None) -> str:
        """Assemble full system prompt.

        Args:
            session_context: Session-level context from context manager.

        Returns:
            Complete system prompt string.
        """
        parts = []
        parts.append(self._build_identity())
        parts.append(self._build_workspace())
        parts.append(self._build_session(session_context))
        return "\n\n".join(p for p in parts if p)

    def _build_identity(self) -> str:
        """Identity layer: agent persona, core behavior. Cached once."""
        if self._identity_cache is not None:
            return self._identity_cache
        self._identity_cache = self._render_identity()
        return self._identity_cache

    def _build_workspace(self) -> str:
        """Workspace layer: project context, tool guidance, env hints."""
        # TODO: Implement workspace prompt building
        # - Scan for AGENTS.md, .cursorrules
        # - Build tool usage guidance
        # - Add environment hints
        return ""

    def _build_session(self, session_context: str | None) -> str:
        """Session layer: topic summaries, memory, timestamp."""
        parts = []
        if session_context:
            parts.append(session_context)

        # Add timestamp
        from datetime import datetime

        parts.append(f"Current time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        return "\n\n".join(parts)

    def _render_identity(self) -> str:
        """Render identity from config or file."""
        identity_path = self.config.agent.identity
        if identity_path and Path(identity_path).exists():
            return Path(identity_path).read_text(encoding="utf-8")
        return "You are a helpful assistant."

    def invalidate_workspace_cache(self) -> None:
        """Invalidate workspace cache when toolset changes."""
        self._workspace_cache = None
        self._workspace_toolset_hash = None