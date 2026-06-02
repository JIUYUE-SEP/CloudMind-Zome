"""Group chat message router: @mention, intent-based, intermind.

Decides which Agents should respond to a group chat message.
"""

from __future__ import annotations

import logging
import random
import re
from dataclasses import dataclass
from typing import List, Optional, Set

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, ChatSession, ChatSessionMember

logger = logging.getLogger(__name__)

_MENTION_RE = re.compile(r"@(\S+)")

# Simple stop-words for keyword matching
_STOP_WORDS: Set[str] = {
    "我", "你", "他", "她", "的", "是", "在", "有", "和", "就", "都", "而",
    "及", "与", "或", "对", "把", "被", "让", "给", "为", "the", "a", "an",
    "is", "are", "in", "on", "to", "of", "and", "or", "it", "this", "that",
}


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
        routing_mode = settings.get("routing_mode", "intent")
        random_reply_count = settings.get("random_reply_count", 1)

        # 1. Parse @mentions
        mentions = _MENTION_RE.findall(content)
        mentioned_ids: set[str] = set()

        for m in mentions:
            # m could be agent name or codename or "队长" or "所有人"
            if m == "队长":
                if session.conductor_agent_id:
                    mentioned_ids.add(session.conductor_agent_id)
            elif m in ("所有人", "all", "全体成员"):
                # @所有人 -> all agent members
                all_agents = await self._get_agent_members(session.id, sender_id)
                for aid in all_agents:
                    mentioned_ids.add(aid)
            else:
                # Try match by name or codename among members
                agent_id = await self._resolve_mention(session.id, m)
                if agent_id:
                    mentioned_ids.add(agent_id)

        if mentioned_ids:
            for aid in mentioned_ids:
                targets.append(RouteTarget(agent_id=aid, reason="mention", is_mentioned=True))
            return targets

        # 2. No mentions -> follow routing_mode
        if routing_mode == "mention":
            return []

        # 3. Intent mode: semantic match then fallback
        agent_ids = await self._get_agent_members(session.id, sender_id)
        if not agent_ids:
            return []

        if routing_mode == "intent":
            intent_targets = await self._intent_route(
                session, sender_id, content, agent_ids, random_reply_count
            )
            if intent_targets:
                return intent_targets

        # Fallback: random selection
        count = min(random_reply_count, len(agent_ids))
        selected = random.sample(agent_ids, count)
        for aid in selected:
            targets.append(RouteTarget(agent_id=aid, reason="random"))

        return targets

    async def _resolve_mention(self, session_id: str, text: str) -> Optional[str]:
        # Single JOIN query to avoid N+1
        # Match: name, codename, or any alias (case-insensitive for English)
        from sqlalchemy import join
        from ..models import Agent
        stmt = (
            select(Agent.id, Agent.name, Agent.codename, Agent.aliases)
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
        query_lower = text.lower()
        for row in result.all():
            if row.name == text or row.codename == text:
                return row.id
            aliases = row.aliases or []
            for alias in aliases:
                if alias.lower() == query_lower:
                    return row.id
        return None

    async def _intent_route(
        self,
        session: ChatSession,
        sender_id: str,
        content: str,
        agent_ids: List[str],
        random_reply_count: int,
    ) -> List["RouteTarget"]:
        """Match user message to agent personality / capabilities via keyword overlap.

        Pure local text matching — no embedding or LLM dependency.
        """
        result = await self.db.execute(
            select(Agent.id, Agent.name, Agent.personality_prompt, Agent.capabilities)
            .where(Agent.id.in_(agent_ids))
        )
        rows = result.all()
        if not rows:
            return []

        user_words = set(self._tokenize(content))
        if not user_words:
            return []

        scores: List[tuple[str, float]] = []
        for row in rows:
            agent_text = " ".join(
                filter(None, [
                    row.name,
                    row.personality_prompt,
                    " ".join(row.capabilities or []),
                ])
            )
            agent_words = set(self._tokenize(agent_text))
            overlap = len(user_words & agent_words)
            score = overlap / max(len(user_words), 1)
            scores.append((row.id, score))
            logger.debug("Intent score for %s: %.2f", row.name, score)

        scores.sort(key=lambda x: x[1], reverse=True)
        best_score = scores[0][1] if scores else 0

        # Strong semantic match -> multiple relevant agents reply together
        if best_score >= 0.08:
            threshold = max(0.03, best_score * 0.5)
            picked = [
                RouteTarget(agent_id=aid, reason="intent")
                for aid, s in scores
                if s >= threshold
            ][:3]  # max 3 agents
            logger.info(
                "Intent route chose %d agents for session %s (best %.2f)",
                len(picked), session.id, best_score,
            )
            return picked

        # Weak / casual chat -> random 2 agents for lively conversation
        logger.info("Intent route weak match, casual chat mode for session %s", session.id)
        count = min(2, len(agent_ids))
        selected = random.sample(agent_ids, count)
        return [RouteTarget(agent_id=aid, reason="random")]

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        """Extract Chinese chars and English words, drop stop-words."""
        words: List[str] = []
        # Chinese characters
        words.extend(re.findall(r"[\u4e00-\u9fff]{2,}", text))
        # English words
        for w in re.findall(r"[a-zA-Z]+", text.lower()):
            if w not in _STOP_WORDS and len(w) > 2:
                words.append(w)
        # Single Chinese chars that are not stop-words
        for ch in re.findall(r"[\u4e00-\u9fff]", text):
            if ch not in _STOP_WORDS:
                words.append(ch)
        return words

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
    is_mentioned: bool = False  # True if this agent was @mentioned
