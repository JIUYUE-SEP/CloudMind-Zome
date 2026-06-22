"""Agent Worker: one asyncio.Task per Agent, FIFO queue, single ReActAgent instance.

Design reference: docs/design/agent-global-worker.md
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Dict

from sqlalchemy import select, update

from ..database import AsyncSessionLocal
from ..models import Agent
from .job_queue import AgentJob, ensure_queue
from .event_bus import manager as event_manager

from engine.agent.react import ReActAgent
from engine.provider.transport import ChatCompletionsTransport
from engine.tool.registry import tool_registry

from engine.agent.workspace import MindWorkspace



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
        self.agent_config: dict | None = None
        self._react_agent: ReActAgent | None = None
        self._running = True
        self._current_job: AgentJob | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        """Load Agent config and build the single ReActAgent instance."""
        try:
            from .agent_resolver import get_agent_config
            self.agent_config = get_agent_config(self.agent_id)

            if not self.agent_config:
                logger.error("AgentWorker cannot start: Agent %s not found", self.agent_id)
                self._running = False
                return

            # Ensure per-agent workspace exists (copy template if missing)
            try:
                MindWorkspace(self.agent_id).ensure_agent_workspace()
            except Exception as exc:
                logger.warning("Failed to ensure workspace for %s: %s", self.agent_id, exc)

            # Resolve provider config: prefer new independent fields, fallback to model_config
            prov_id, model_name, prov_type = await self._resolve_model_config()

            # Build transport (reused; lazy-build if provider missing)
            transport = await self._build_transport()
            if transport is None:
                logger.error("AgentWorker cannot start: no transport for %s", self.agent_id)
                self._running = False
                return

            # Capability kill-switches default to True
            enable_semantic_search = bool(self.agent_config.get("semantic_search_enabled", True))
            enable_image_generation = bool(self.agent_config.get("image_generation_enabled", True))
            enable_topic_compression = bool(self.agent_config.get("topic_compression_enabled", True))

            model_cfg = dict(self.agent_config.get("model_config") or {})

            # Resolve marker provider credentials (best-effort; failure disables topic compression)
            marker_cfg = model_cfg.get("marker") or {}
            marker_provider_id = self.agent_config.get("marker_provider_id") or marker_cfg.get("provider_id")
            marker_model_id = self.agent_config.get("marker_model_id") or marker_cfg.get("model")

            if enable_topic_compression and marker_provider_id:
                try:
                    from .provider_resolver import resolve_provider_credentials
                    async with AsyncSessionLocal() as db:
                        marker_creds = await resolve_provider_credentials(
                            db, marker_provider_id, marker_model_id
                        )
                    if marker_creds:
                        model_cfg.setdefault("marker", {})
                        model_cfg["marker"]["provider"] = prov_type
                        model_cfg["marker"]["base_url"] = marker_creds.base_url
                        model_cfg["marker"]["model"] = marker_creds.model_id or model_name
                    else:
                        logger.warning("Agent %s marker credentials unresolved; topic compression disabled", self.agent_id)
                        enable_topic_compression = False
                except Exception as e:
                    logger.warning("Agent %s marker config failed; topic compression disabled: %s", self.agent_id, e)
                    enable_topic_compression = False

            # Build fallback transports from Agent.fallback_chain (new field) or model_config
            fallback_transports: dict[str, ChatCompletionsTransport] = {}
            fb_chain_raw: list[dict] = (
                (self.agent_config.get("fallback_chain") or [])
                or model_cfg.get("fallback_chain")
                or []
            )

            from .provider_resolver import resolve_provider_credentials
            from engine.provider.factory import build_transport

            for fb_item in fb_chain_raw:
                if not isinstance(fb_item, dict):
                    continue
                fb_prov_id = fb_item.get("provider_id")
                fb_model = fb_item.get("model") or fb_item.get("model_id") or model_name
                fb_type = fb_item.get("provider") or prov_type

                async with AsyncSessionLocal() as db:
                    fb_creds = await resolve_provider_credentials(db, fb_prov_id or "")
                    if not fb_creds:
                        # Legacy fallback: try by provider type
                        fb_creds = await resolve_provider_credentials(db, fb_type)

                if fb_creds and fb_creds.api_key and fb_creds.base_url:
                    fb_transport = await build_transport(
                        fb_creds.provider_type,
                        fb_model,
                        lambda _t, c=fb_creds: {"base_url": c.base_url, "api_key": c.api_key},
                        auth_mode=fb_creds.auth_mode,
                        custom_headers=fb_creds.custom_headers,
                        request_timeout=fb_creds.request_timeout,
                        max_retries=fb_creds.max_retries,
                    )
                    if fb_transport:
                        fb_key = f"{fb_creds.provider_id}::{fb_model}"
                        fallback_transports[fb_key] = fb_transport
                        logger.info("Built fallback transport for %s (%s)", fb_key, fb_model)
                else:
                    logger.warning("Failed to resolve fallback provider %s", fb_prov_id or fb_type)

            # ---- Build agent-level embedder ----
            from engine.context.embedder import Embedder
            embedder = None
            if enable_semantic_search and self.agent_config.get("embedder_provider_id") and self.agent_config.get("embedder_model_id"):
                try:
                    async with AsyncSessionLocal() as db:
                        emb_creds = await resolve_provider_credentials(
                            db, self.agent_config.get("embedder_provider_id"), self.agent_config.get("embedder_model_id")
                        )
                    if emb_creds and emb_creds.base_url and emb_creds.api_key:
                        embedder = Embedder(
                            base_url=emb_creds.base_url,
                            api_key=emb_creds.api_key,
                            model=self.agent_config.get("embedder_model_id"),
                        )
                        logger.info("Agent %s embedder ready (%s)", self.agent_id, self.agent_config.get("embedder_model_id"))
                    else:
                        logger.warning("Agent %s embedder credentials incomplete; semantic search disabled", self.agent_id)
                        enable_semantic_search = False
                except Exception as e:
                    logger.warning("Agent %s embedder build failed; semantic search disabled: %s", self.agent_id, e)
                    enable_semantic_search = False
            else:
                if enable_semantic_search:
                    logger.info("Agent %s has no embedder configured; semantic search disabled", self.agent_id)
                enable_semantic_search = False

            # ---- Inject agent-level image generation config ----
            if enable_image_generation and self.agent_config.get("imagegen_provider_id") and self.agent_config.get("imagegen_model_id"):
                try:
                    async with AsyncSessionLocal() as db:
                        img_creds = await resolve_provider_credentials(
                            db, self.agent_config.get("imagegen_provider_id"), self.agent_config.get("imagegen_model_id")
                        )
                    if img_creds and img_creds.base_url and img_creds.api_key:
                        from engine.tools.web.image_gen_context import set_image_gen_config_for_agent
                        set_image_gen_config_for_agent(self.agent_id, {
                            "base_url": img_creds.base_url,
                            "model": self.agent_config.get("imagegen_model_id"),
                            "api_key": img_creds.api_key,
                        })
                        logger.info("Agent %s image-gen ready (%s)", self.agent_id, self.agent_config.get("imagegen_model_id"))
                    else:
                        logger.warning("Agent %s image-gen credentials incomplete; image generation disabled", self.agent_id)
                        enable_image_generation = False
                except Exception as e:
                    logger.warning("Agent %s image-gen config failed; image generation disabled: %s", self.agent_id, e)
                    enable_image_generation = False
            else:
                if enable_image_generation:
                    logger.info("Agent %s has no image-gen configured; image generation disabled", self.agent_id)
                enable_image_generation = False

            # Create per-agent session store (isolated to agent workspace)
            from engine.session.store import SessionStore
            agent_session_store = SessionStore(agent_id=self.agent_id)
            await agent_session_store.connect()

            # Create the single ReActAgent instance
            from ..main import _app_state as _state
            app_config = _state["config"]
            self._react_agent = ReActAgent(
                name=self.agent_config.get("name", ""),
                model=transport,
                toolkit=tool_registry,
                session_store=agent_session_store,
                agent_id=self.agent_id,
                config=app_config,
                embedder=embedder,
                memory_store=_state.get("memory_store"),
                model_config=model_cfg,
                fallback_transports=fallback_transports,
                codename=self.agent_config.get("codename") or self.agent_config.get("name", ""),
                allowed_paths=self.agent_config.get("allowed_paths") or [],
                toolsets=self.agent_config.get("toolsets") or [],
                enabled_skills=self.agent_config.get("enabled_skills") or [],
                enable_semantic_search=enable_semantic_search,
                enable_image_generation=enable_image_generation,
                enable_topic_compression=enable_topic_compression,
            )

            logger.info("AgentWorker started for %s (%s)", self.agent_config.get("name", ""), self.agent_id)
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
            job: AgentJob | None = None
            try:
                job = await asyncio.wait_for(self.queue.get(), timeout=60.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            self._current_job = job
            try:
                await self._execute_job(job)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Job execution failed for Agent %s", self.agent_id)
                if job and job.future and not job.future.done():
                    job.future.set_exception(RuntimeError("Job failed"))
            finally:
                self._current_job = None
                if job:
                    self.queue.task_done()
                # B: Safety net — restore idle if _execute_job's finally was interrupted
                try:
                    await asyncio.shield(self._set_db_status("idle"))
                except Exception:
                    pass

        # Graceful shutdown: final cleanup
        try:
            await asyncio.shield(self._set_db_status("idle"))
        except Exception:
            pass

    def stop(self) -> None:
        """Signal shutdown."""
        self._running = False
        # Signal the current job to stop so stream loops can exit early
        if self._current_job:
            self._current_job.stop_event.set()
        # Clean up agent-scoped image gen config
        try:
            from engine.tools.web.image_gen_context import remove_image_gen_config_for_agent
            remove_image_gen_config_for_agent(self.agent_id)
        except Exception:
            pass
        # Close per-agent session store
        if self._react_agent and self._react_agent.session_store:
            try:
                import asyncio
                asyncio.create_task(self._react_agent.session_store.close())
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------
    async def _execute_job(self, job: AgentJob) -> None:
        """Run a single Job through the ReActAgent."""
        if not self._react_agent or not self.agent_config:
            try:
                await job.on_done("[Agent 未就绪]", False)
            except Exception:
                pass
            return

        # NEW: Ingest-only job (group chat — write memory, no reply)
        if job.ingest_only:
            try:
                await self._react_agent.ingest_message(
                    user_message=job.content,
                    source=job.source,
                    source_id=job.source_id,
                    source_name=job.source_name,
                    sender_name=job.sender_name,
                    content_type=job.content_type,
                )
            except Exception as exc:
                logger.warning("Agent %s ingest failed: %s", self.agent_id, exc)
            finally:
                await asyncio.shield(self._set_db_status("idle"))
                try:
                    await job.on_done("", True)
                except Exception:
                    pass
            return

        # Set busy status
        await self._set_db_status("busy")

        # Prepare scene info for system prompt injection
        scene_info = self._build_scene_info(job)

        full_content = ""
        tool_names: list[str] = []
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
                is_mentioned=job.is_mentioned,
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
                    if tool_name:
                        tool_names.append(tool_name)
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
            # A: Shield status restore from CancelledError during shutdown
            try:
                user_preview = job.content[:200].replace("\n", " ") if job else ""
                reply_preview = full_content[:400].replace("\n", " ") if full_content else ""
                note_lines = [
                    f"- source: {job.source} ({job.source_id})",
                    f"- user: {job.sender_name or '用户'}: {user_preview}",
                    f"- reply: {reply_preview}",
                ]
                if tool_names:
                    note_lines.append(f"- tools: {', '.join(tool_names)}")
                MindWorkspace(self.agent_id).append_daily_note("\n".join(note_lines))
            except Exception as exc:
                logger.debug("Failed to write daily note for %s: %s", self.agent_id, exc)
            try:
                await asyncio.shield(self._set_db_status("idle"))
            except Exception:
                pass
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

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _build_scene_info(self, job: AgentJob) -> str:
        """Build scene description for system prompt injection.

        Engine no longer injects [time | scene | sender] tags.
        Group chat sender is handled by MessageBuilder._with_sender_prefix().
        """
        if job.source == "workflow" and job.source_id.startswith("wf:"):
            parts = job.source_id.split(":")
            if len(parts) >= 3:
                return f"工作流节点：{parts[2]}"
        return ""

    async def _set_db_status(self, status: str) -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Agent).where(Agent.id == self.agent_id).values(status=status)
            )
            await db.commit()
        # Sync in-memory state so safety-net checks are accurate
        if self.agent_config:
            self.agent_config["status"] = status
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

    async def _resolve_model_config(self) -> tuple[str, str, str]:
        """Return (provider_id, model_name, provider_type).

        Prefer new independent fields; fallback to legacy model_config JSON.
        If legacy config only has provider name (not id), resolve id from DB.
        """
        # New fields
        prov_id = self.agent_config.get("provider_id", "")
        model_name = self.agent_config.get("model_id", "")
        prov_type = ""

        if prov_id and model_name:
            return prov_id, model_name, prov_type

        # Legacy fallback
        model_cfg: dict = self.agent_config.get("model_config") or {}
        prov_id = model_cfg.get("provider_id", prov_id)
        model_name = model_cfg.get("model", model_name) or "deepseek-v4-pro"
        prov_type = (model_cfg.get("provider") or "deepseek").lower()

        # Backward compat: old agents may have provider name without id
        if not prov_id and prov_type:
            from ..models import ComputeProvider
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(ComputeProvider).where(
                        ComputeProvider.provider_type == prov_type,
                        ComputeProvider.status == "active",
                    ).limit(1)
                )
                prov = result.scalar_one_or_none()
                if prov:
                    prov_id = prov.id
                    logger.info(
                        "Resolved legacy provider name '%s' to id '%s' for agent %s",
                        prov_type, prov_id, self.agent_id,
                    )

        return prov_id, model_name, prov_type

    async def _build_transport(self) -> ChatCompletionsTransport | None:
        """Resolve provider credentials and build transport via engine factory."""
        if not self.agent_config:
            return None

        prov_id, model_name, prov_type = await self._resolve_model_config()

        from .provider_resolver import resolve_provider_credentials
        async with AsyncSessionLocal() as db:
            creds = await resolve_provider_credentials(db, prov_id, model_name)

        if not creds:
            logger.error("Cannot build transport: no credentials for provider %s", prov_id)
            return None

        from engine.provider.factory import build_transport
        return await build_transport(
            creds.provider_type or prov_type,
            model_name,
            lambda _t: {"base_url": creds.base_url, "api_key": creds.api_key or ""},
            auth_mode=creds.auth_mode,
            custom_headers=creds.custom_headers,
            request_timeout=creds.request_timeout,
            max_retries=creds.max_retries,
        )


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
    """Put a Job into the Agent's queue (thread-safe)."""
    worker = await ensure_worker(agent_id)
    async with _worker_lock:
        # Verify the worker is still alive after ensure_worker returned.
        if agent_id not in _workers or not worker._running:
            raise RuntimeError(f"AgentWorker for {agent_id} is no longer running")
        await worker.queue.put(job)


def get_current_job(agent_id: str) -> AgentJob | None:
    """Return the currently executing Job for an Agent (or None if idle)."""
    w = _workers.get(agent_id)
    return w._current_job if w else None
