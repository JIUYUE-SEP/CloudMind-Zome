"""EngineBridge: adapts platform requests to the Agent Worker queue.

Each request is packaged as an AgentJob and dispatched to the Agent's
single Worker Task. The Worker processes Jobs FIFO.

Old design: create a fresh ReActAgent per request.
New design: dispatch to a global AgentWorker queue.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator

from sqlalchemy import select
from engine.provider.transport import ChatCompletionsTransport
from engine.provider.thinking.deepseek import DeepSeekThinkingProfile
from engine.provider.thinking.glm import GLMThinkingProfile
from engine.provider.thinking.kimicode import KimiCodeThinkingProfile
from engine.provider.thinking.mimo import MiMoThinkingProfile
from engine.context.manager import ContextManager
from engine.session.store import SessionStore
from engine.config.loader import load_config
from engine.config.models import AppConfig

from ..models import Agent, ComputeProvider
from .job_queue import AgentJob
from .agent_worker import dispatch_job

logger = logging.getLogger(__name__)

_PROFILE_MAP = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,
}

_DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com/v1",
    "mimo": "https://api.miaomi.cn/v1",
    "kimicode": "https://api.kimi.ai/v1",
    "glm": "https://api.glm.ai/v1",
}


def _decrypt_key(enc: str) -> str:
    import base64
    return base64.b64decode(enc.encode()).decode()


def _engine_state() -> dict:
    """Access global app state (same as ws.py)."""
    from ..main import _app_state
    return _app_state


class EngineBridge:
    """Bridge: platform requests -> AgentWorker queue."""

    def __init__(
        self,
        session_store: SessionStore,
        context_manager: ContextManager,
        app_config: AppConfig | None = None,
    ):
        self.session_store = session_store
        self.context_manager = context_manager
        if app_config is None:
            import pathlib
            _cfg_path = pathlib.Path(__file__).resolve().parent.parent.parent / "engine" / "config.yaml"
            app_config = load_config(_cfg_path)
        self.app_config = app_config

    # ------------------------------------------------------------------
    # Streaming interface (for WS private / group chat)
    # ------------------------------------------------------------------
    async def stream_chat(
        self,
        agent_id: str,
        session_id: str,
        user_message: str,
        source: str = "private",
        source_name: str = "",
        sender_name: str = "",
    ) -> AsyncIterator[dict[str, Any]]:
        """Dispatch a Job to the Agent Worker and yield streaming chunks."""
        agent_row = await self._get_agent(agent_id)
        if agent_row is None:
            yield {"type": "error", "message": f"Agent {agent_id} not found"}
            return

        chunk_queue: asyncio.Queue[dict] = asyncio.Queue()

        async def on_chunk(text: str) -> None:
            # If WS consumer is very slow, skip new chunks rather than
            # dropping oldest (which would make the stream unreadable).
            if chunk_queue.qsize() > 1000:
                logger.warning("Chunk queue overflow for agent %s, skipping chunk", agent_id)
                return
            await chunk_queue.put({"type": "content", "data": {"text": text}})

        async def on_done(text: str, ok: bool) -> None:
            await chunk_queue.put({"type": "done"})

        job = AgentJob(
            source=source,
            source_id=session_id,
            source_name=source_name or ("私聊" if source == "private" else "群聊"),
            sender_name=sender_name,
            content=user_message,
            on_chunk=on_chunk,
            on_done=on_done,
        )

        await dispatch_job(agent_id, job)

        # Yield chunks until done
        while True:
            try:
                event = await asyncio.wait_for(chunk_queue.get(), timeout=600.0)
            except asyncio.TimeoutError:
                yield {"type": "error", "message": "Agent response timeout"}
                return

            if event["type"] == "done":
                return
            yield event

    # ------------------------------------------------------------------
    # Synchronous interface (for workflow nodes)
    # ------------------------------------------------------------------
    async def run_sync(
        self,
        agent_id: str,
        session_id: str,
        instruction: str,
        source_name: str = "工作流",
    ) -> str:
        """Dispatch a Job and block until completion. Returns full text."""
        agent_row = await self._get_agent(agent_id)
        if agent_row is None:
            raise RuntimeError(f"Agent {agent_id} not found")

        future: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        chunks: list[str] = []

        async def on_chunk(text: str) -> None:
            chunks.append(text)

        async def on_done(text: str, ok: bool) -> None:
            if not future.done():
                future.set_result("".join(chunks))

        job = AgentJob(
            source="workflow",
            source_id=session_id,
            source_name=source_name,
            sender_name="工作流引擎",
            content=instruction,
            on_chunk=on_chunk,
            on_done=on_done,
            future=future,
        )

        await dispatch_job(agent_id, job)
        return await future

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    async def _get_agent(self, agent_id: str) -> Agent | None:
        from ..database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Agent).where(Agent.id == agent_id, Agent.deleted_at.is_(None))
            )
            return result.scalar_one_or_none()

    async def _build_transport(self, agent_row: Agent) -> ChatCompletionsTransport | None:
        """Kept for compatibility; Worker builds its own transport."""
        model_cfg: dict = agent_row.model_config or {}
        provider_type = (model_cfg.get("provider") or "deepseek").lower()
        model_name = model_cfg.get("model") or "deepseek-v4-pro"

        result = await self.db.execute(
            select(ComputeProvider).where(
                ComputeProvider.provider_type == provider_type,
                ComputeProvider.status == "active",
            ).limit(1)
        )
        prov_row: ComputeProvider | None = result.scalars().first()

        base_url = _DEFAULT_BASE_URLS.get(provider_type, "")
        api_key = ""

        if prov_row:
            base_url = (prov_row.config or {}).get("base_url") or base_url
            api_key = _decrypt_key(prov_row.api_key_encrypted) if prov_row.api_key_encrypted else ""
        else:
            engine_cfg = getattr(self.app_config.provider, provider_type, None)
            if engine_cfg:
                base_url = engine_cfg.base_url or base_url
                api_key = engine_cfg.api_key or ""

        if not api_key:
            logger.error("No API key for provider %s", provider_type)
            return None

        profile_cls = _PROFILE_MAP.get(provider_type, DeepSeekThinkingProfile)
        return ChatCompletionsTransport(
            base_url=base_url,
            api_key=api_key,
            model=model_name,
            thinking_profile=profile_cls(),
        )
