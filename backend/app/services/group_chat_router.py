"""Group chat message router: @mention, intent-based, intermind.

Decides which Agents should respond to a group chat message.
"""

from __future__ import annotations

import logging
import random
import re
from dataclasses import dataclass
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, ChatSession, ChatSessionMember

logger = logging.getLogger(__name__)

_MENTION_RE = re.compile(r"@(\S+)")


class GroupChatRouter:
    """Routes incoming group messages to target agents."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def route(
        self,
        session: ChatSession,
        sender_id: str,
        content: str,
    ) -> List["RouteTarget"]:
        """Determine which agents should respond.

        Returns list of RouteTarget with reason.
        """
        targets: List[RouteTarget] = []
        settings = session.settings or {}
        routing_mode = settings.get("routing_mode", "mention")
        random_reply_count = settings.get("random_reply_count", 1)

        # 1. Parse @mentions
        mentions = _MENTION_RE.findall(content)
        mentioned_ids: set[str] = set()

        for m in mentions:
            # m could be agent name or codename or "队长"
            if m == "队长":
                if session.conductor_agent_id:
                    mentioned_ids.add(session.conductor_agent_id)
            else:
                # Try match by name or codename among members
                agent_id = await self._resolve_mention(session.id, m)
                if agent_id:
                    mentioned_ids.add(agent_id)

        if mentioned_ids:
            for aid in mentioned_ids:
                targets.append(RouteTarget(agent_id=aid, reason="mention"))
            return targets

        # 2. No mentions -> follow routing_mode
        if routing_mode == "mention":
            # Only respond if explicitly @'d; otherwise no one responds
            return []

        # 3. Intent mode or fallback: pick random agents
        # All agent members are eligible (Worker handles FIFO)
        agent_ids = await self._get_agent_members(session.id, sender_id)
        if not agent_ids:
            return []

        # Simple random selection
        count = min(random_reply_count, len(agent_ids))
        selected = random.sample(agent_ids, count)
        for aid in selected:
            targets.append(RouteTarget(agent_id=aid, reason="random"))

        return targets

    async def _resolve_mention(self, session_id: str, text: str) -> Optional[str]:
        # Single JOIN query to avoid N+1
        from sqlalchemy import join
        from ..models import Agent
        stmt = (
            select(Agent.id, Agent.name, Agent.codename)
            .select_from(
                join(
                    ChatSessionMember,
                    Agent,
                    ChatSessionMember.member_id == Agent.id,
                )
            )
            .where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_type == "agent",
            )
        )
        result = await self.db.execute(stmt)
        for row in result.all():
            if row.name == text or row.codename == text:
                return row.id
        return None

    async def _get_agent_members(
        self, session_id: str, exclude_sender: str
    ) -> List[str]:
        """Return all agent members in the session (status no longer filters,
        because AgentWorker handles FIFO serialization)."""
        result = await self.db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.session_id == session_id,
                ChatSessionMember.member_type == "agent",
            )
        )
        ids = []
        for m in result.scalars().all():
            if m.member_id == exclude_sender:
                continue
            ids.append(m.member_id)
        return ids


@dataclass
class RouteTarget:
    agent_id: str
    reason: str  # mention | random | intermind
