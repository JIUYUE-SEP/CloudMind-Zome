"""Multi-agent coordinator: routes tasks between agents, shares context.

Design reference: §5.3 多 Agent 协作（远期预留）, §6.6.2 on_receive/on_send hooks
"""

from __future__ import annotations

import logging
from typing import Any

from ..message.types import Message, TextBlock
from ..session.store import SessionStore

logger = logging.getLogger(__name__)


class AgentCoordinator:
    """Coordinates multiple agents: task delegation, context sharing, result aggregation.

    Design reference: §5.3 - 主 Agent 派发子任务，多 Agent 协作
    """

    def __init__(self, session_store: SessionStore | None = None):
        self._agents: dict[str, Any] = {}  # name -> ReActAgent
        self.session_store = session_store

    def register(self, name: str, agent: Any) -> None:
        """Register an agent."""
        self._agents[name] = agent
        logger.info("Registered agent: %s", name)

    async def delegate(
        self,
        from_agent: str,
        to_agent: str,
        task: str,
        context: str = "",
    ) -> str:
        """Delegate a task from one agent to another.

        Args:
            from_agent: Source agent name.
            to_agent: Target agent name.
            task: Task description.
            context: Additional context to pass.

        Returns:
            Result from the target agent.
        """
        if to_agent not in self._agents:
            raise ValueError(f"Agent '{to_agent}' not found")

        target = self._agents[to_agent]

        # Build delegation message with context from source agent
        full_message = task
        if context:
            full_message = f"[Context from {from_agent}]\n{context}\n\n[Task]\n{task}"

        # Inject peer context before streaming
        if self.session_store and target.session_id:
            from_agent_summary = await self._get_agent_summary(from_agent)
            if from_agent_summary:
                await target.on_receive(
                    Message(role="system", content=f"Related work by {from_agent}: {from_agent_summary}")
                )

        # Run target agent
        result_parts = []
        async for event in target.stream(full_message):
            if event.type == "content" and event.data:
                result_parts.append(event.data.text if hasattr(event.data, "text") else str(event.data))
            elif event.type == "done":
                break

        result = "\n".join(result_parts)

        # Notify source agent of result
        source = self._agents.get(from_agent)
        if source:
            await source.on_send(
                Message(role="system", content=f"Result from {to_agent}: {result[:500]}")
            )

        return result

    async def broadcast(
        self,
        from_agent: str,
        message: str,
        exclude: list[str] | None = None,
    ) -> None:
        """Broadcast a message to all other agents.

        Args:
            from_agent: Source agent name.
            message: Message to broadcast.
            exclude: Agent names to exclude.
        """
        exclude = exclude or []
        for name, agent in self._agents.items():
            if name != from_agent and name not in exclude:
                await agent.on_receive(
                    Message(role="system", content=f"[{from_agent}] {message}")
                )

    async def _get_agent_summary(self, agent_name: str) -> str:
        """Get summary of an agent's recent work from session store."""
        agent = self._agents.get(agent_name)
        if not agent or not self.session_store or not agent.session_id:
            return ""

        try:
            messages = await self.session_store.load_messages(agent.session_id, limit=10)
            # Extract key points from recent messages
            summaries = []
            for msg in messages[-5:]:
                text = msg.get_text() if hasattr(msg, "get_text") else str(msg.content)
                if len(text.strip()) > 20:
                    summaries.append(text[:200])
            return "; ".join(summaries) if summaries else ""
        except Exception as e:
            logger.warning("Failed to get agent summary: %s", e)
            return ""

    def list_agents(self) -> list[str]:
        """List all registered agent names."""
        return list(self._agents.keys())
