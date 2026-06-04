"""CloudMind-Zome Platform FastAPI entry.

Integrates product-level REST/WebSocket APIs with the Agent engine.
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Ensure backend/ is on path so `from engine...` resolves
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from engine.config.loader import load_config
from engine.session.store import SessionStore
from engine.tool.registry import tool_registry
from .database import engine, Base
from .api import auth, agents, upload, chat, groups, actions, approvals, compute, commissions, ws, config
from .services.commission_scheduler import get_scheduler

logger = logging.getLogger(__name__)

# Module-level state shared with ws.py (avoids circular import via app.state)
_app_state: dict = {}


# ------------------------------------------------------------------
# Lifespan
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create tables + init engine infra; Shutdown: dispose."""
    # 1. Platform tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Run lightweight migrations for additive schema changes
        def _migrate(sync_conn):
            from sqlalchemy import inspect, text
            inspector = inspect(sync_conn)
            cols = {c['name'] for c in inspector.get_columns('chat_messages')}
            if 'tool_calls' not in cols:
                sync_conn.execute(text("ALTER TABLE chat_messages ADD COLUMN tool_calls JSON"))
                logger.info("Migration: added chat_messages.tool_calls")
            if 'reasoning' not in cols:
                sync_conn.execute(text("ALTER TABLE chat_messages ADD COLUMN reasoning TEXT"))
                logger.info("Migration: added chat_messages.reasoning")
        await conn.run_sync(_migrate)
    logger.info("Platform tables ensured")

    # 2. Engine infra
    cfg = load_config(_BACKEND_DIR / "engine" / "config.yaml")
    app.state.config = cfg

    # Discover tools (inside local engine/)
    tools_dir = _BACKEND_DIR / "engine" / "tools"
    if tools_dir.exists():
        discovered = tool_registry.discover(str(tools_dir), package="engine.tools")
        logger.info("Discovered %d tool modules", len(discovered))
    else:
        logger.warning("Tools directory not found: %s", tools_dir)

    # Inject communication callbacks so engine tools can dispatch
    # without importing platform code.
    from engine.tools.comms.dispatchers import register_comms_callbacks
    from app.services.agent_communication import (
        dispatch_private_message,
        dispatch_workflow_progress,
    )
    register_comms_callbacks(
        send_private_message=dispatch_private_message,
        report_workflow_progress=dispatch_workflow_progress,
    )
    logger.info("Communication callbacks injected into engine")

    # Session store (connects to unified cloudmind.db)
    store = SessionStore()
    await store.connect()
    logger.info("SessionStore connected to unified DB")
    app.state.session_store = store

    # Assistant model transport for background NLP (memory compression, etc.)
    am_cfg = cfg.assistant_model
    assistant_transport = None
    if am_cfg.base_url and am_cfg.model and am_cfg.api_key:
        from engine.provider.transport import ChatCompletionsTransport
        from engine.provider.thinking.plain import PlainThinkingProfile
        assistant_transport = ChatCompletionsTransport(
            base_url=am_cfg.base_url,
            api_key=am_cfg.api_key,
            model=am_cfg.model,
            thinking_profile=PlainThinkingProfile(),
            timeout=60.0,
        )
        logger.info("Assistant model (%s) ready", am_cfg.model)
    else:
        logger.warning("Assistant model not configured; memory compression will skip LLM steps")

    # Embedding model (for semantic memory search)
    from engine.context.embedder import Embedder
    from engine.context.vector_store import AgentMemoryStore

    embedder = Embedder(cfg.embedding_model)
    memory_store = AgentMemoryStore()
    if cfg.embedding_model.base_url and cfg.embedding_model.model and cfg.embedding_model.api_key:
        logger.info("Embedding model (%s) ready for semantic search", cfg.embedding_model.model)
    else:
        logger.warning("Embedding model not configured; semantic memory search disabled")

    # Share with ws module
    _app_state["config"] = cfg
    _app_state["session_store"] = store
    _app_state["embedder"] = embedder
    _app_state["memory_store"] = memory_store

    # Start commission scheduler (Agent主动性: cron/interval任务)
    scheduler = get_scheduler()
    await scheduler.start()

    yield

    # Shutdown
    scheduler = get_scheduler()
    await scheduler.stop()
    await store.close()
    await engine.dispose()
    logger.info("Shutdown complete")


# ------------------------------------------------------------------
# App
# ------------------------------------------------------------------
app = FastAPI(
    title="CloudMind-Zome",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://localhost:1420", "tauri://localhost"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files for uploads
_upload_dir = Path.home() / ".cloudmind-zome" / "uploads"
app.mount("/uploads", StaticFiles(directory=str(_upload_dir)), name="uploads")

# Routers
app.include_router(auth.router, prefix="/api/v1")
app.include_router(agents.router, prefix="/api/v1")

app.include_router(upload.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(groups.router, prefix="/api/v1")
app.include_router(actions.router, prefix="/api/v1")
app.include_router(approvals.router, prefix="/api/v1")
app.include_router(compute.router, prefix="/api/v1")
app.include_router(commissions.router, prefix="/api/v1")
app.include_router(config.router, prefix="/api/v1")
app.include_router(ws.router)


# ------------------------------------------------------------------
# System
# ------------------------------------------------------------------
@app.get("/api/v1/system/health")
async def health():
    return {
        "code": 0,
        "data": {"status": "ok", "version": "0.1.0", "database": "connected"},
    }
