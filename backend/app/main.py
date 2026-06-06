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
from .database import engine, Base, AsyncSessionLocal, WORKSPACE_ROOT
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
    # 0. Ensure workspace root exists
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

    # 0.5 Migrate old agent directories if present
    old_agents_dir = Path.home() / ".cloudmind-zome" / "agents"
    if old_agents_dir.exists() and old_agents_dir.is_dir():
        import shutil
        for agent_dir in old_agents_dir.iterdir():
            if agent_dir.is_dir():
                target = WORKSPACE_ROOT / agent_dir.name
                if not target.exists():
                    shutil.copytree(agent_dir, target)
                    logger.info("Migrated agent workspace: %s -> %s", agent_dir, target)

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

    from engine.context.embedder import Embedder
    from engine.context.vector_store import AgentMemoryStore
    from .models import Setting, ComputeProvider
    from sqlalchemy import select
    import base64

    embedder = Embedder(base_url="", api_key="", model="")
    memory_store = AgentMemoryStore()

    async with AsyncSessionLocal() as db:
        # ---- Embedding model (for semantic memory search) ----
        result = await db.execute(
            select(Setting).where(Setting.key == "embedding_model")
        )
        setting = result.scalar_one_or_none()

        if setting and setting.value:
            prov_id = setting.value.get("provider_id")
            model_name = setting.value.get("model")

            if prov_id and model_name:
                prov_result = await db.execute(
                    select(ComputeProvider).where(
                        ComputeProvider.id == prov_id,
                        ComputeProvider.status == "active",
                    )
                )
                prov = prov_result.scalar_one_or_none()
                if prov:
                    base_url = (prov.config or {}).get("base_url", "")
                    api_key = ""
                    if prov.api_key_encrypted:
                        try:
                            api_key = base64.b64decode(prov.api_key_encrypted.encode()).decode()
                        except Exception:
                            api_key = prov.api_key_encrypted
                    if base_url and api_key:
                        embedder = Embedder(
                            base_url=base_url,
                            api_key=api_key,
                            model=model_name,
                        )
                        logger.info("Embedding model (%s via %s) ready for semantic search", model_name, prov_id)
                    else:
                        logger.warning("Embedding provider %s missing base_url or api_key", prov_id)
                else:
                    logger.warning("Embedding provider %s not found or inactive", prov_id)
            else:
                logger.warning("Embedding model setting incomplete (provider_id or model missing)")
        else:
            logger.warning("Embedding model not configured in settings; semantic memory search disabled")

        # ---- Image generation model ----
        img_result = await db.execute(
            select(Setting).where(Setting.key == "image_gen")
        )
        img_setting = img_result.scalar_one_or_none()
        if img_setting and img_setting.value:
            img_prov_id = img_setting.value.get("provider_id")
            img_model = img_setting.value.get("model")
            if img_prov_id:
                img_prov_result = await db.execute(
                    select(ComputeProvider).where(
                        ComputeProvider.id == img_prov_id,
                        ComputeProvider.status == "active",
                    )
                )
                img_prov = img_prov_result.scalar_one_or_none()
                if img_prov:
                    img_base_url = (img_prov.config or {}).get("base_url", "")
                    img_api_key = ""
                    if img_prov.api_key_encrypted:
                        try:
                            img_api_key = base64.b64decode(img_prov.api_key_encrypted.encode()).decode()
                        except Exception:
                            img_api_key = img_prov.api_key_encrypted
                    if img_base_url and img_api_key and img_model:
                        from engine.tools.web.generate_image import set_image_gen_config
                        set_image_gen_config({
                            "base_url": img_base_url,
                            "model": img_model,
                            "api_key": img_api_key,
                        })
                        logger.info("Image generation model (%s via %s) ready", img_model, img_prov_id)
                    else:
                        logger.warning("Image generation provider %s missing base_url/api_key/model", img_prov_id)
                else:
                    logger.warning("Image generation provider %s not found or inactive", img_prov_id)
            else:
                logger.warning("Image generation setting incomplete (provider_id missing)")
        else:
            logger.warning("Image generation not configured in settings")

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
