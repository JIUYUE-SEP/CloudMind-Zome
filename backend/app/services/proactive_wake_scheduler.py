"""Proactive wake scheduler: Agents spontaneously message users.

Triggers:
- Private chat: after random(1,3)h idle, user online, 50% chance
- Offline wake: on WS connect, greeting based on away duration
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, update

from ..database import AsyncSessionLocal
from ..models import Agent, AgentUserRelation, ChatMessage, ChatSession, ChatSessionMember, User
from .agent_worker import AgentJob, dispatch_job
from .engine_bridge import EngineBridge
from .event_bus import manager

logger = logging.getLogger(__name__)

# user_id -> last_disconnect_time (approximate)
_last_seen: dict[str, datetime] = {}


# ------------------------------------------------------------------
# Scheduler
# ------------------------------------------------------------------
class ProactiveWakeScheduler:
    """Polls intimacy table and dispatches proactive wake jobs."""

    def __init__(self, interval_seconds: float = 300.0):
        self.interval = interval_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("Proactive wake scheduler started (interval=%ss)", self.interval)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Proactive wake scheduler stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._tick()
            except Exception:
                logger.exception("Proactive wake tick failed")
            await asyncio.sleep(self.interval)

    async def _tick(self) -> None:
        now = datetime.now(timezone.utc)
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(AgentUserRelation).where(
                    AgentUserRelation.score > 50,  # Only for acquainted+
                )
            )
            relations = result.scalars().all()

            for rel in relations:
                try:
                    await self._check_and_wake(rel, now)
                except Exception:
                    logger.exception("Proactive wake check failed for %s", rel.agent_id)

    async def _check_and_wake(
        self, rel: AgentUserRelation, now: datetime
    ) -> None:
        """Check conditions and dispatch wake job if met."""
        last = rel.last_interaction_at or now
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        idle_hours = (now - last).total_seconds() / 3600

        # Condition 1: idle > random(1, 3) hours
        threshold = random.uniform(1.0, 3.0)
        if idle_hours < threshold:
            return

        # Condition 2: user online (has WS connection)
        if rel.user_id not in manager.get_online_users():
            return

        # Condition 3: Agent not in active group session
        async with AsyncSessionLocal() as db:
            # Check if agent is member of any recently-active group session
            # (simplification: any group session where last_message_at < 10 min)
            result = await db.execute(
                select(ChatSessionMember).where(
                    ChatSessionMember.member_id == rel.agent_id,
                    ChatSessionMember.member_type == "agent",
                )
            )
            members = result.scalars().all()
            for m in members:
                sess = await db.execute(
                    select(ChatSession).where(ChatSession.id == m.session_id)
                )
                s = sess.scalar_one_or_none()
                if s and s.type == "group" and s.last_message_at:
                    lmt = s.last_message_at
                    if lmt.tzinfo is None:
                        lmt = lmt.replace(tzinfo=timezone.utc)
                    if (now - lmt).total_seconds() < 600:
                        return  # Agent is in an active group

        # Condition 4: random 50%
        if random.random() > 0.5:
            return

        # All conditions met -> dispatch wake job
        await self._dispatch_wake(rel)

    async def _dispatch_wake(self, rel: AgentUserRelation) -> None:
        """Send a proactive message from agent to user."""
        agent_id = rel.agent_id
        user_id = rel.user_id

        # Build wake prompt based on intimacy level
        wake_type = random.choice(["greeting", "share", "care"])
        prompt = self._build_wake_prompt(wake_type, rel.level)

        # Find or create private session
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ChatSession).where(
                    ChatSession.type == "private",
                )
            )
            private_session = None
            for s in result.scalars().all():
                mems = await db.execute(
                    select(ChatSessionMember).where(
                        ChatSessionMember.session_id == s.id,
                    )
                )
                ids = {m.member_id for m in mems.scalars().all()}
                if agent_id in ids and user_id in ids:
                    private_session = s
                    break

            if not private_session:
                # Create private session
                private_session = ChatSession(
                    id=str(uuid.uuid4()),
                    type="private",
                    name="私聊",
                )
                db.add(private_session)
                db.add(ChatSessionMember(session_id=private_session.id, member_id=user_id, member_type="user"))
                db.add(ChatSessionMember(session_id=private_session.id, member_id=agent_id, member_type="agent"))
                await db.commit()

            session_id = private_session.id

            # Lookup agent name
            agent_result = await db.execute(select(Agent).where(Agent.id == agent_id))
            agent = agent_result.scalar_one_or_none()
            agent_name = agent.name if agent else "Agent"

        full_content = ""

        async def on_text_chunk(text: str) -> None:
            nonlocal full_content
            full_content += text

        async def on_done(text: str, ok: bool) -> None:
            if ok and full_content:
                # Persist message
                try:
                    async with AsyncSessionLocal() as db2:
                        msg = ChatMessage(
                            id=str(uuid.uuid4()),
                            session_id=session_id,
                            sender_id=agent_id,
                            sender_type="agent",
                            content=full_content,
                        )
                        db2.add(msg)
                        await db2.commit()
                except Exception:
                    logger.exception("Persist proactive wake msg failed")

                # Push WS frame
                frame = {
                    "type": "chat.message",
                    "payload": {
                        "session_id": session_id,
                        "message": {
                            "id": str(uuid.uuid4()),
                            "sender_id": agent_id,
                            "sender_type": "agent",
                            "sender_name": agent_name,
                            "content": full_content,
                            "content_type": "text",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "is_me": False,
                        },
                    },
                }
                try:
                    await manager.send_to_user(user_id, frame)
                except Exception:
                    pass

        job = AgentJob(
            source="proactive_wake",
            source_id=f"{session_id}:{agent_id}",
            source_name="主动唤醒",
            sender_name="系统",
            content=prompt,
            on_text_chunk=on_text_chunk,
            on_done=on_done,
        )
        await dispatch_job(agent_id, job)
        # Update last_interaction_at
        try:
            async with AsyncSessionLocal() as db3:
                await db3.execute(
                    update(AgentUserRelation)
                    .where(AgentUserRelation.agent_id == agent_id, AgentUserRelation.user_id == user_id)
                    .values(last_interaction_at=datetime.now(timezone.utc))
                )
                await db3.commit()
        except Exception:
            pass
        logger.info("Proactive wake dispatched: agent=%s user=%s type=%s", agent_id, user_id, wake_type)

    @staticmethod
    def _build_wake_prompt(wake_type: str, level: str) -> str:
        base = "你是用户的数字伙伴。用户已经有一段时间没和你说话了。"
        if wake_type == "greeting":
            return base + "请主动打个招呼，自然、随意，像老朋友一样。不超过30字。"
        if wake_type == "share":
            return base + "请分享一个你最近想到的话题或问题，吸引用户继续聊。不超过40字。"
        if wake_type == "care":
            return base + "请表达一点关心，问问用户最近在忙什么。不超过30字。"
        return base + "请简短打个招呼。"


# ------------------------------------------------------------------
# Offline wake (on WS connect)
# ------------------------------------------------------------------
async def send_offline_wake(user_id: str, ws) -> None:
    """Called when a user (re)connects via WebSocket.

    Dispatches a proactive wake Job through the Agent Worker so the
    agent actually generates a contextual greeting (not a fake hardcoded one).
    """
    now = datetime.now(timezone.utc)
    last = _last_seen.get(user_id)
    if not last:
        _last_seen[user_id] = now
        return

    away_hours = (now - last).total_seconds() / 3600
    _last_seen[user_id] = now

    # Pick a random agent that has a private session with this user
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ChatSessionMember).where(
                ChatSessionMember.member_id == user_id,
                ChatSessionMember.member_type == "user",
            )
        )
        user_members = result.scalars().all()
        candidates = []
        for m in user_members:
            sess = await db.execute(
                select(ChatSession).where(
                    ChatSession.id == m.session_id,
                    ChatSession.type == "private",
                )
            )
            s = sess.scalar_one_or_none()
            if s:
                # Find the agent in this session
                mems = await db.execute(
                    select(ChatSessionMember).where(
                        ChatSessionMember.session_id == s.id,
                        ChatSessionMember.member_type == "agent",
                    )
                )
                for am in mems.scalars().all():
                    agent = await db.execute(select(Agent).where(Agent.id == am.member_id))
                    a = agent.scalar_one_or_none()
                    if a:
                        candidates.append((s.id, a.id, a.name))

        if not candidates:
            return

        session_id, agent_id, agent_name = random.choice(candidates)

    # Build a contextual prompt based on away duration
    if away_hours < 1:
        prompt = "用户刚回来，请简短打个招呼，像刚走开了一会儿的样子。不超过20字。"
    elif away_hours < 6:
        prompt = "用户离开了一段时间刚回来，请自然地打个招呼或说点什么。不超过30字。"
    elif away_hours < 24:
        prompt = "用户离开了半天多，请表达一下你在这段时间的想法或问候。不超过40字。"
    else:
        prompt = "用户很久没来了，请真诚地打个招呼，可以提一下之前的聊天。不超过50字。"

    full_content = ""

    async def on_text_chunk(text: str) -> None:
        nonlocal full_content
        full_content += text

    async def on_done(text: str, ok: bool) -> None:
        if ok and full_content:
            # Persist
            try:
                async with AsyncSessionLocal() as db2:
                    msg = ChatMessage(
                        id=str(uuid.uuid4()),
                        session_id=session_id,
                        sender_id=agent_id,
                        sender_type="agent",
                        content=full_content,
                    )
                    db2.add(msg)
                    await db2.commit()
            except Exception:
                logger.exception("Persist offline wake msg failed")

            # Push WS frame
            frame = {
                "type": "chat.message",
                "payload": {
                    "session_id": session_id,
                    "message": {
                        "id": str(uuid.uuid4()),
                        "sender_id": agent_id,
                        "sender_type": "agent",
                        "sender_name": agent_name,
                        "content": full_content,
                        "content_type": "text",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "is_me": False,
                    },
                },
            }
            try:
                await manager.send_to_user(user_id, frame)
            except Exception:
                pass

    job = AgentJob(
        source="proactive_wake",
        source_id=f"{session_id}:{agent_id}",
        source_name="重连问候",
        sender_name="系统",
        content=prompt,
        on_text_chunk=on_text_chunk,
        on_done=on_done,
    )
    await dispatch_job(agent_id, job)


# ------------------------------------------------------------------
# Singleton
# ------------------------------------------------------------------
_wake_scheduler: ProactiveWakeScheduler | None = None


def get_wake_scheduler() -> ProactiveWakeScheduler:
    global _wake_scheduler
    if _wake_scheduler is None:
        _wake_scheduler = ProactiveWakeScheduler()
    return _wake_scheduler
