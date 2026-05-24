"""Agent Worker: one asyncio.Task per Agent, FIFO queue, single ReActAgent instance.

Design reference: docs/design/agent-global-worker.md
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import Agent
from .job_queue import AgentJob, ensure_queue
from .event_bus import manager as event_manager

from engine.agent.react import ReActAgent
from engine.provider.transport import ChatCompletionsTransport
from engine.tool.registry import tool_registry
from engine.context.manager import ContextManager
from engine.session.store import SessionStore
from engine.config.loader import load_config
from engine.config.models import AppConfig



logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Global Worker registry
# ------------------------------------------------------------------
_workers: Dict[str, "AgentWorker"] = {}
_worker_tasks: Dict[str, asyncio.Task] = {}
_startup_events: Dict[str, asyncio.Event] = {}
_worker_lock = asyncio.Lock()


# ------------------------------------------------------------------
# AgentWorker
# ------------------------------------------------------------------
class AgentWorker:
    """Single-threaded worker for one Agent.

    - One asyncio.Queue (FIFO)
    - One ReActAgent instance (never recreated)
    - Status managed reliably (idle → busy → idle)
    """

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.queue = ensure_queue(agent_id)
        self.agent_row: Agent | None = None
        self._react_agent: ReActAgent | None = None
        self._running = True
        self._current_job: AgentJob | None = None
        self._context_manager: ContextManager | None = None
        self._last_activity = datetime.now(timezone.utc)
        self._introspected_at: datetime | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        """Load Agent config and build the single ReActAgent instance."""
        try:
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(Agent).where(Agent.id == self.agent_id, Agent.deleted_at.is_(None))
                )
                self.agent_row = result.scalar_one_or_none()

            if not self.agent_row:
                logger.error("AgentWorker cannot start: Agent %s not found", self.agent_id)
                self._running = False
                return

            # Build transport (reused; lazy-build if provider missing)
            transport = await self._build_transport()
            if transport is None:
                logger.error("AgentWorker cannot start: no transport for %s", self.agent_id)
                self._running = False
                return

            # Create the single ReActAgent instance
            from ..main import _app_state as _state
            app_config = _state["config"]
            self._context_manager = _state["context_manager"]
            self._react_agent = ReActAgent(
                name=self.agent_row.name,
                model=transport,
                toolkit=tool_registry,
                context_manager=self._context_manager,
                session_store=_state["session_store"],
                agent_id=self.agent_id,
                config=app_config,
                personality_prompt=self.agent_row.personality_prompt or "",
                embedder=_state.get("embedder"),
                memory_store=_state.get("memory_store"),
            )

            logger.info("AgentWorker started for %s (%s)", self.agent_row.name, self.agent_id)
        finally:
            # Notify waiters regardless of success/failure so they don't hang
            event = _startup_events.pop(self.agent_id, None)
            if event:
                event.set()

    async def run(self) -> None:
        """Main loop: consume Jobs FIFO."""
        await self.start()
        if not self._running:
            return

        while self._running:
            try:
                job: AgentJob = await asyncio.wait_for(self.queue.get(), timeout=60.0)
            except asyncio.TimeoutError:
                await self._maybe_introspect()
                continue

            self._last_activity = datetime.now(timezone.utc)
            self._current_job = job
            try:
                await self._execute_job(job)
            except Exception:
                logger.exception("Job execution failed for Agent %s", self.agent_id)
                if job.future and not job.future.done():
                    job.future.set_exception(RuntimeError("Job failed"))
            finally:
                self._current_job = None
                self.queue.task_done()

    def stop(self) -> None:
        """Signal shutdown."""
        self._running = False
        # Cancel current job's stop event to unblock any awaiters
        if self._current_job:
            self._current_job.stop_event.set()

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------
    async def _execute_job(self, job: AgentJob) -> None:
        """Run a single Job through the ReActAgent."""
        if not self._react_agent or not self.agent_row:
            try:
                await job.on_done("[Agent 未就绪]", False)
            except Exception:
                pass
            return

        # Set busy status
        await self._set_db_status("busy")

        # Prepare scene info for system prompt injection
        scene_info = self._build_scene_info(job)

        full_content = ""
        success = True

        try:
            # Stream through ReActAgent — all blocks arrive in API order
            async for event in self._react_agent.stream(
                user_message=job.content,
                scene_info=scene_info,
                source=job.source,
                source_id=job.source_id,
                source_name=job.source_name,
                sender_name=job.sender_name,
                content_type=job.content_type,
            ):
                # Check stop signal (global stop or private chat stop)
                if not self._running or (job.source == "private" and job.stop_event.is_set()):
                    logger.info("Job %s stopped", job.job_id)
                    await job.on_chunk("\n[已暂停]")
                    success = False
                    break

                if event.type == "content":
                    text = event.data.text if hasattr(event.data, "text") else str(event.data)
                    full_content += text
                    try:
                        await job.on_chunk(text)
                        if job.on_text_chunk:
                            await job.on_text_chunk(text)
                    except Exception:
                        pass

                elif event.type == "thinking":
                    thinking_text = event.data.thinking if hasattr(event.data, "thinking") else str(event.data)
                    try:
                        await job.on_chunk(f"\x01THINKING\x01{thinking_text}")
                    except Exception:
                        pass

                elif event.type == "tool_call":
                    tool_name = event.data.name if hasattr(event.data, "name") else ""
                    tool_input = event.data.input if hasattr(event.data, "input") else {}
                    try:
                        await job.on_chunk(f"\x01TOOL_CALL\x01{tool_name}:{json.dumps(tool_input, ensure_ascii=False)}")
                    except Exception:
                        pass

                elif event.type == "done":
                    break

                elif event.type == "error":
                    error_text = event.data.text if hasattr(event.data, "text") else str(event.data)
                    full_content += f"\n[错误: {error_text}]"
                    try:
                        await job.on_chunk(f"\n[错误: {error_text}]")
                    except Exception:
                        pass
                    success = False
                    break

        except Exception as exc:
            logger.exception("ReActAgent stream failed for job %s", job.job_id)
            full_content += f"\n[错误: {exc}]"
            success = False

        finally:
            # Restore idle status
            await self._set_db_status("idle")
            # Notify caller
            try:
                await job.on_done(full_content, success)
            except Exception:
                logger.warning("on_done failed for job %s (client likely disconnected)", job.job_id)
            if job.future and not job.future.done():
                if success:
                    job.future.set_result(full_content)
                else:
                    job.future.set_exception(RuntimeError(f"Job failed: {full_content}"))

    async def _maybe_introspect(self) -> None:
        """If idle for >5 min and memory has grown, compress / reflect."""
        now = datetime.now(timezone.utc)
        idle_seconds = (now - self._last_activity).total_seconds()
        if idle_seconds < 300:
            return
        if self._introspected_at and (now - self._introspected_at).total_seconds() < 300:
            return
        if not self._react_agent or not self._context_manager:
            return
        msg_count = len(self._react_agent._messages)
        if msg_count <= 10:
            return

        logger.info("Agent %s entering introspection (%d messages)", self.agent_id, msg_count)
        await self._set_db_status("introspecting")
        try:
            if self._context_manager:
                compressed = await self._context_manager._compress_topics(
                    self._react_agent._messages, self.agent_id
                )
                self._react_agent._messages = compressed
                self._introspected_at = now
                logger.info("Agent %s introspection complete: %d -> %d messages",
                            self.agent_id, msg_count, len(compressed))
        except Exception:
            logger.exception("Agent %s introspection failed", self.agent_id)
        finally:
            await self._set_db_status("idle")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _build_scene_info(self, job: AgentJob) -> str:
        """Build scene description for system prompt injection.
        Keep it concise and avoid meta-discussion triggers."""
        lines = [f"当前场景：{job.source_name}"]
        if job.source == "group":
            lines.append(f"发言者：{job.sender_name}")
        elif job.source == "workflow":
            lines.append("任务类型：工作流执行")
            if job.source_id.startswith("wf:"):
                parts = job.source_id.split(":")
                if len(parts) >= 3:
                    lines.append(f"节点：{parts[2]}")
        elif job.source == "private":
            lines.append(f"对话者：{job.sender_name or '用户'}")
        return "\n".join(lines)

    async def _set_db_status(self, status: str) -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Agent).where(Agent.id == self.agent_id).values(status=status)
            )
            await db.commit()
        # Broadcast to all connected clients
        try:
            await event_manager.broadcast({
                "type": "agent.status",
                "payload": {
                    "agent_id": self.agent_id,
                    "status": status,
                },
            })
        except Exception:
            pass

    async def _build_transport(self) -> ChatCompletionsTransport | None:
        """Resolve provider credentials and build transport via engine factory."""
        if not self.agent_row:
            return None

        model_cfg: dict = self.agent_row.model_config or {}
        provider_id = model_cfg.get("provider_id")
        provider_type = (model_cfg.get("provider") or "deepseek").lower()
        model_name = model_cfg.get("model") or "deepseek-v4-pro"

        async def _resolve(ptype: str) -> dict | None:
            from ..models import ComputeProvider
            async with AsyncSessionLocal() as db:
                # Prefer provider_id for exact match
                if provider_id:
                    result = await db.execute(
                        select(ComputeProvider).where(
                            ComputeProvider.id == provider_id,
                            ComputeProvider.status == "active",
                        ).limit(1)
                    )
                    prov = result.scalars().first()
                else:
                    result = await db.execute(
                        select(ComputeProvider).where(
                            ComputeProvider.provider_type == ptype,
                            ComputeProvider.status == "active",
                        ).limit(1)
                    )
                    prov = result.scalars().first()

            base_url = ""
            api_key = ""

            if prov:
                base_url = (prov.config or {}).get("base_url", "")
                if prov.api_key_encrypted:
                    import base64
                    try:
                        api_key = base64.b64decode(prov.api_key_encrypted.encode()).decode()
                    except Exception:
                        api_key = prov.api_key_encrypted
            # Fallback to engine config
            if not api_key:
                from ..main import _app_state
                cfg = _app_state.get("config")
                if cfg:
                    ec = getattr(cfg.provider, ptype, None)
                    if ec:
                        base_url = ec.base_url or base_url
                        api_key = ec.api_key or api_key

            if not api_key:
                return None
            return {"base_url": base_url, "api_key": api_key}

        from engine.provider.factory import build_transport
        return await build_transport(provider_type, model_name, _resolve)


# ------------------------------------------------------------------
# Public API
# ------------------------------------------------------------------
async def ensure_worker(agent_id: str) -> AgentWorker:
    """Return existing worker or create + start a new one (thread-safe)."""
    # Fast path: already running
    if agent_id in _workers:
        return _workers[agent_id]

    async with _worker_lock:
        # Double-check after acquiring lock
        if agent_id in _workers:
            return _workers[agent_id]

        event = asyncio.Event()
        _startup_events[agent_id] = event

        worker = AgentWorker(agent_id)
        _workers[agent_id] = worker
        task = asyncio.create_task(worker.run())
        _worker_tasks[agent_id] = task

    # Wait outside the lock so other Agent creations aren't blocked
    try:
        await asyncio.wait_for(event.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        logger.error("AgentWorker startup timeout for %s", agent_id)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        async with _worker_lock:
            _workers.pop(agent_id, None)
            _worker_tasks.pop(agent_id, None)
        raise RuntimeError(f"AgentWorker startup timeout for agent {agent_id}")

    if not worker._running:
        # Startup failed inside start() (e.g. Agent not found, no transport)
        raise RuntimeError(f"AgentWorker failed to start for agent {agent_id}")

    return worker


async def dispatch_job(agent_id: str, job: AgentJob) -> None:
    """Put a Job into the Agent's queue. Worker must already exist (started lazily)."""
    worker = await ensure_worker(agent_id)
    await worker.queue.put(job)


async def stop_worker(agent_id: str) -> None:
    """Gracefully stop a worker."""
    if agent_id in _workers:
        _workers[agent_id].stop()
    if agent_id in _worker_tasks:
        _worker_tasks[agent_id].cancel()
        try:
            await _worker_tasks[agent_id]
        except asyncio.CancelledError:
            pass
        del _worker_tasks[agent_id]
        del _workers[agent_id]
    _startup_events.pop(agent_id, None)


def get_current_job(agent_id: str) -> AgentJob | None:
    """Return the currently executing Job for an Agent (or None if idle)."""
    w = _workers.get(agent_id)
    return w._current_job if w else None
