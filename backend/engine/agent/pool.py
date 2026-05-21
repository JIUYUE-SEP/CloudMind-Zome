"""Agent pool: manages multiple long-lived Agent instances per session.

Design reference: §6.17 Agent 抽象层扩展 — 多 Agent 协作

Each session gets its own ReActAgent with isolated conversation history.
Requests for the same session are serialized via asyncio.Lock.
Requests for different sessions run in parallel.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, Callable

from .react import ReActAgent

logger = logging.getLogger(__name__)


class AgentPool:
    """Manages multiple ReActAgent instances keyed by session_id.

    - Per-session Agent: isolated _messages, long-lived in memory.
    - Per-session Lock: serializes concurrent requests for the same session.
    - Parallel across sessions: different sessions run simultaneously.
    - LRU eviction: when max_agents reached, oldest idle Agent is removed
      and its history persisted to SQLite.
    """

    def __init__(
        self,
        agent_factory: Callable[[str], ReActAgent],
        max_agents: int = 50,
        max_idle_seconds: float = 3600.0,
    ):
        self.agent_factory = agent_factory
        self.max_agents = max_agents
        self.max_idle_seconds = max_idle_seconds

        self._agents: dict[str, ReActAgent] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_active: dict[str, float] = {}
        self._global_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get(self, session_id: str) -> ReActAgent:
        """Get or create an Agent for session_id.

        Thread-safe across sessions.  Same-session calls are serialized
        by the caller via :meth:`acquire`.
        """
        import time

        async with self._global_lock:
            if session_id not in self._agents:
                if len(self._agents) >= self.max_agents:
                    await self._evict_oldest()

                agent = self.agent_factory(session_id)
                self._agents[session_id] = agent
                self._locks[session_id] = asyncio.Lock()
                logger.info(
                    "Created agent for session %s (total: %d)",
                    session_id,
                    len(self._agents),
                )

            self._last_active[session_id] = time.time()
            return self._agents[session_id]

    @asynccontextmanager
    async def acquire(self, session_id: str) -> Any:
        """Context manager: get Agent + exclusive lock for session.

        Usage::

            async with pool.acquire(session_id) as agent:
                async for event in agent.stream(...): ...
        """
        agent = await self.get(session_id)
        async with self._locks[session_id]:
            yield agent

    async def remove(self, session_id: str) -> None:
        """Remove an Agent from the pool.

        History is already persisted in real-time by ReActAgent._save_message,
        so no additional save is needed here.
        """
        async with self._global_lock:
            agent = self._agents.pop(session_id, None)
            self._locks.pop(session_id, None)
            self._last_active.pop(session_id, None)

            if agent:
                logger.info("Removed agent for session %s", session_id)

    async def clear(self) -> None:
        """Remove all Agents, saving history.  Called on shutdown."""
        async with self._global_lock:
            sessions = list(self._agents.keys())
            for sid in sessions:
                await self.remove(sid)

    def list_active(self) -> list[str]:
        """Return list of active session IDs."""
        return list(self._agents.keys())

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _evict_oldest(self) -> None:
        """Evict the least-recently-used idle Agent."""
        import time

        if not self._last_active:
            return

        # Find oldest
        now = time.time()
        candidates = {
            sid: ts
            for sid, ts in self._last_active.items()
            if now - ts > self.max_idle_seconds
        }
        if not candidates:
            # Force eviction of absolute oldest if no one is idle enough
            candidates = self._last_active

        oldest_sid = min(candidates, key=candidates.get)  # type: ignore[arg-type]
        logger.info("Evicting agent for session %s (LRU)", oldest_sid)
        await self.remove(oldest_sid)
