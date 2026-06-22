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
from engine.config.loader import load_config
from engine.config.models import AppConfig

from ..models import Agent
from .job_queue import AgentJob
from .agent_worker import dispatch_job

logger = logging.getLogger(__name__)


def _engine_state() -> dict:
    """Access global app state (same as ws.py)."""
    from ..main import _app_state
    return _app_state


class EngineBridge:
    """Bridge: platform requests -> AgentWorker queue."""

    def __init__(
        self,
        app_config: AppConfig | None = None,
    ):
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
        content_type: str = "text",
        is_mentioned: bool = False,
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
            # Parse special prefixes injected by AgentWorker for thinking/tool_call
            if text.startswith("\x01THINKING\x01"):
                thinking_text = text[len("\x01THINKING\x01"):]
                await chunk_queue.put({"type": "thinking", "data": {"thinking": thinking_text}})
                return
            if text.startswith("\x01TOOL_CALL\x01"):
                rest = text[len("\x01TOOL_CALL\x01"):]
                if ":" in rest:
                    tool_name, tool_input_json = rest.split(":", 1)
                    try:
                        import json
                        tool_input = json.loads(tool_input_json)
                    except Exception:
                        tool_input = {}
                    await chunk_queue.put({"type": "tool_call", "data": {"name": tool_name, "input": tool_input}})
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
            content_type=content_type,
            is_mentioned=is_mentioned,
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

        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        chunks: list[str] = []

        async def on_text_chunk(text: str) -> None:
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
            on_text_chunk=on_text_chunk,
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
        from ..database import AsyncSessionLocal
        from .provider_resolver import resolve_provider_credentials

        # Prefer new fields, fallback to legacy model_config
        prov_id = agent_row.provider_id or ""
        model_name = agent_row.model_id or ""
        prov_type = ""

        if not prov_id or not model_name:
            model_cfg: dict = agent_row.model_config or {}
            prov_id = model_cfg.get("provider_id", prov_id)
            model_name = model_cfg.get("model", model_name) or "deepseek-v4-pro"
            prov_type = (model_cfg.get("provider") or "deepseek").lower()

        async with AsyncSessionLocal() as db:
            creds = await resolve_provider_credentials(db, prov_id, model_name)

        if not creds:
            logger.error("No active ComputeProvider for agent %s (provider_id=%s)", agent_row.id, prov_id)
            return None

        effective_type = creds.provider_type or prov_type
        from engine.provider.factory import build_transport
        return await build_transport(
            effective_type,
            model_name,
            lambda _t: {"base_url": creds.base_url, "api_key": creds.api_key or ""},
            auth_mode=creds.auth_mode,
            custom_headers=creds.custom_headers,
            request_timeout=creds.request_timeout,
            max_retries=creds.max_retries,
        )
