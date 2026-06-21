"""CloudMind-Zome Platform FastAPI entry.

Integrates product-level REST/WebSocket APIs with the Agent engine.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Ensure backend/ is on path so `from engine...` resolves
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from engine.config.loader import load_config
from engine.session.store import SessionStore
from engine.tool.registry import tool_registry
from .database import engine, Base, AsyncSessionLocal, DATA_DIR, UPLOAD_DIR, ZVEC_DIR, WORKSPACE_ROOT
from engine.tools.file.security import is_safe_path
from .api import agents, upload, chat, groups, actions, approvals, compute, commissions, ws, config, tools, models as models_api, user
from .services.commission_scheduler import get_scheduler
from .services.bootstrap import ensure_builtin_provider
from .services.key_migration import migrate_plaintext_keys

logger = logging.getLogger(__name__)


# Paths under /uploads that are public static assets (e.g. default avatars).
_PUBLIC_UPLOAD_PREFIXES = {
    "avatars/default.png",
    "avatars/default.jpg",
}


def _is_public_upload_path(relative_path: str) -> bool:
    return relative_path.replace("\\", "/") in _PUBLIC_UPLOAD_PREFIXES


def _load_cors_origins() -> list[str]:
    """Return allowed CORS origins from env or sensible dev defaults."""
    raw = os.environ.get("CLOUDMIND_CORS_ORIGINS", "")
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return ["http://localhost", "http://localhost:1420", "tauri://localhost"]


async def _serve_upload(request: Request) -> JSONResponse:
    """Serve a file from UPLOAD_DIR with path traversal protection only."""
    relative_path = request.path_params.get("path", "")
    normalized = relative_path.replace("\\", "/")

    if not normalized or ".." in normalized:
        return JSONResponse(status_code=403, content={"code": 403, "message": "Forbidden path"})

    file_path = UPLOAD_DIR / normalized
    try:
        file_path = file_path.resolve()
        upload_root = UPLOAD_DIR.resolve()
        if not str(file_path).startswith(str(upload_root)):
            return JSONResponse(status_code=403, content={"code": 403, "message": "Forbidden path"})
    except Exception:
        return JSONResponse(status_code=403, content={"code": 403, "message": "Forbidden path"})

    if not file_path.is_file():
        return JSONResponse(status_code=404, content={"code": 404, "message": "File not found"})

    from fastapi.responses import FileResponse
    return FileResponse(str(file_path))

# Module-level state shared with ws.py (avoids circular import via app.state)
_app_state: dict = {}

_startup_start: float = 0.0


def _startup_log(label: str, start: float) -> float:
    """Log a startup stage and return the current timestamp for the next stage."""
    now = time.perf_counter()
    logger.info("[startup] %s: %.3fs (total %.3fs)", label, now - start, now - _startup_start)
    return now


async def _run_agent_cleanup_once() -> None:
    """One-time cleanup: clear old agent config, messages, zvec, mind files."""
    marker = WORKSPACE_ROOT / ".v2_agent_cleanup_done"
    if marker.exists():
        return

    import aiosqlite
    import shutil

    # 1. Clear agent provider settings and mind data from DB
    async with AsyncSessionLocal() as db:
        from sqlalchemy import text
        await db.execute(text("""
            UPDATE agents SET
                provider_id = NULL,
                model_id = NULL,
                temperature = NULL,
                top_p = NULL,
                marker_provider_id = NULL,
                marker_model_id = NULL,
                embedder_provider_id = NULL,
                embedder_model_id = NULL,
                compressor_provider_id = NULL,
                compressor_model_id = NULL,
                imagegen_provider_id = NULL,
                imagegen_model_id = NULL,
                fallback_chain = NULL,
                personality = NULL,
                max_context_tokens = NULL,
                model_config = '{}'
        """))
        await db.commit()
        logger.info("Agent cleanup: cleared provider settings and mind data")

    # 2. Clear agent_messages table if it already exists (created later by
    # SessionStore on new installs; skip on OperationalError to avoid blocking
    # first-time startup).
    db_path = DATA_DIR / "cloudmind.db"
    if db_path.exists():
        try:
            async with aiosqlite.connect(str(db_path)) as conn:
                await conn.execute("DELETE FROM agent_messages")
                await conn.commit()
            logger.info("Agent cleanup: cleared agent_messages")
        except aiosqlite.OperationalError:
            logger.info("Agent cleanup: agent_messages table not present yet, skipping")

    # 3. Clear zvec collections
    zvec_dir = ZVEC_DIR
    if zvec_dir.exists():
        shutil.rmtree(str(zvec_dir), ignore_errors=True)
        logger.info("Agent cleanup: cleared zvec collections")

    # 4. Clear workspace mind files (keep directory structure)
    for agent_dir in WORKSPACE_ROOT.iterdir():
        if agent_dir.is_dir():
            for fname in ("SOUL.md", "AGENT.md", "USER.md", "MEMORY.md"):
                fpath = agent_dir / fname
                if fpath.exists():
                    fpath.write_text("", encoding="utf-8")
            logger.info("Agent cleanup: cleared mind files for %s", agent_dir.name)

    marker.write_text("done", encoding="utf-8")
    logger.info("Agent cleanup completed")

    # 5. Shutdown tool executor
    from engine.tool.registry import shutdown_tool_executor
    shutdown_tool_executor()
    logger.info("Tool executor shut down")


# ------------------------------------------------------------------
# Lifespan
# ------------------------------------------------------------------
def _tool_permission_checker(permission: str, arguments: dict[str, Any]) -> bool:
    """Global permission hook for tool execution.

    Enforces file path policy via is_safe_path. Non-file permissions are
    allowed by default; agent-level toolset gating can be added here later.
    """
    if not permission.startswith("file:"):
        return True

    path = arguments.get("path")
    if not path or not isinstance(path, str):
        return False

    mode_map = {
        "file:read": "read",
        "file:write": "write",
        "file:edit": "write",
        "file:share": "share",
        "file:delete": "delete",
    }
    mode = mode_map.get(permission, "read")
    ok, _ = is_safe_path(path, mode=mode)
    return ok


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create tables + init engine infra; Shutdown: dispose."""
    global _startup_start
    _startup_start = time.perf_counter()
    t = _startup_start

    # 0. Ensure workspace root exists
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    t = _startup_log("ensure workspace", t)

    # 0.5 Migrate old agent directories if present
    old_agents_dir = DATA_DIR / "agents"
    if old_agents_dir.exists() and old_agents_dir.is_dir():
        import shutil
        for agent_dir in old_agents_dir.iterdir():
            if agent_dir.is_dir():
                target = WORKSPACE_ROOT / agent_dir.name
                if not target.exists():
                    shutil.copytree(agent_dir, target)
                    logger.info("Migrated agent workspace: %s -> %s", agent_dir, target)
    t = _startup_log("migrate old dirs", t)

    # 1. Platform tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Run lightweight migrations for additive schema changes
        def _migrate(sync_conn):
            from sqlalchemy import inspect, text
            import re

            inspector = inspect(sync_conn)
            cols = {c['name'] for c in inspector.get_columns('chat_messages')}
            if 'tool_calls' not in cols:
                sync_conn.execute(text("ALTER TABLE chat_messages ADD COLUMN tool_calls JSON"))
                logger.info("Migration: added chat_messages.tool_calls")
            if 'reasoning' not in cols:
                sync_conn.execute(text("ALTER TABLE chat_messages ADD COLUMN reasoning TEXT"))
                logger.info("Migration: added chat_messages.reasoning")
            # Agent allowed_paths migration
            agent_cols = {c['name'] for c in inspector.get_columns('agents')}
            if 'allowed_paths' not in agent_cols:
                sync_conn.execute(text("ALTER TABLE agents ADD COLUMN allowed_paths JSON"))
                logger.info("Migration: added agents.allowed_paths")
            if 'toolsets' not in agent_cols:
                sync_conn.execute(text("ALTER TABLE agents ADD COLUMN toolsets JSON"))
                logger.info("Migration: added agents.toolsets")
            if 'enabled_skills' not in agent_cols:
                sync_conn.execute(text("ALTER TABLE agents ADD COLUMN enabled_skills JSON"))
                logger.info("Migration: added agents.enabled_skills")
            # Provider refactor migrations (batch 1)
            prov_cols = {c['name'] for c in inspector.get_columns('compute_providers')}
            new_prov_cols = [
                ("base_url", "TEXT"),
                ("auth_mode", "TEXT DEFAULT 'api_key'"),
                ("custom_headers", "TEXT"),
                ("request_timeout", "REAL DEFAULT 120.0"),
                ("max_retries", "INTEGER DEFAULT 3"),
                ("rate_limit_qpm", "INTEGER DEFAULT 0"),
                ("require_api_key", "INTEGER DEFAULT 1"),
                ("is_builtin", "INTEGER DEFAULT 0"),
                ("description", "TEXT"),
            ]
            for col_name, col_def in new_prov_cols:
                if col_name not in prov_cols:
                    sync_conn.execute(text(f"ALTER TABLE compute_providers ADD COLUMN {col_name} {col_def}"))
                    logger.info("Migration: added compute_providers.%s", col_name)
            # Agent provider refactor columns
            agent_new_cols = [
                ("provider_id", "TEXT"),
                ("model_id", "TEXT"),
                ("temperature", "REAL"),
                ("top_p", "REAL"),
                ("marker_provider_id", "TEXT"),
                ("marker_model_id", "TEXT"),
                ("embedder_provider_id", "TEXT"),
                ("embedder_model_id", "TEXT"),
                ("compressor_provider_id", "TEXT"),
                ("compressor_model_id", "TEXT"),
                ("imagegen_provider_id", "TEXT"),
                ("imagegen_model_id", "TEXT"),
                ("fallback_chain", "TEXT"),
                ("personality", "TEXT"),
                ("max_context_tokens", "INTEGER"),
                ("semantic_search_enabled", "INTEGER DEFAULT 1"),
                ("image_generation_enabled", "INTEGER DEFAULT 1"),
                ("topic_compression_enabled", "INTEGER DEFAULT 1"),
            ]
            for col_name, col_def in agent_new_cols:
                if col_name not in agent_cols:
                    sync_conn.execute(text(f"ALTER TABLE agents ADD COLUMN {col_name} {col_def}"))
                    logger.info("Migration: added agents.%s", col_name)

            # ---- Model type classification migration ----
            def infer_model_type(model_id: str) -> str:
                lower = model_id.lower()
                DISCOVERY_RULES = [
                    (r"\b(ada-002|ada\b|text-embedding|embedding|embed|bge-|e5-|gte-|m3e-|m-e5|multilingual-e5|nv-embed)", "embedding"),
                    (r"\b(dall-e|flux|sdxl|stable-diffusion|midjourney|wanx|cogview|kling|imagen|playground|recraft|ideogram)", "image"),
                    (r"\b(whisper|sensevoice|sense|nova-|stt-|asr-|speech-to-text|speech)", "stt"),
                ]
                for pattern, t in DISCOVERY_RULES:
                    if re.search(pattern, lower):
                        return t
                return "llm"

            model_cols_info = {c['name']: c for c in inspector.get_columns('llm_models')}
            ctx_col = model_cols_info.get('context_window')

            # Rebuild llm_models if context_window is still NOT NULL
            if ctx_col and ctx_col.get('nullable') is False:
                sync_conn.execute(text("PRAGMA foreign_keys = OFF"))
                sync_conn.execute(text("""
                    CREATE TABLE llm_models_new (
                        id TEXT PRIMARY KEY,
                        provider_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT NOT NULL,
                        is_builtin INTEGER DEFAULT 0,
                        status TEXT DEFAULT 'active',
                        context_window INTEGER,
                        max_output_tokens INTEGER,
                        supports_multimodal INTEGER DEFAULT 0,
                        input_modalities TEXT,
                        output_modalities TEXT,
                        supports_streaming INTEGER DEFAULT 1,
                        supports_tool_calling INTEGER DEFAULT 0,
                        supports_reasoning INTEGER DEFAULT 0,
                        pricing TEXT,
                        model_type TEXT DEFAULT 'llm' NOT NULL,
                        created_at TEXT,
                        updated_at TEXT
                    )
                """))
                sync_conn.execute(text("""
                    INSERT INTO llm_models_new SELECT
                        id, provider_id, user_id, display_name, is_builtin, status,
                        context_window, max_output_tokens, supports_multimodal,
                        input_modalities, output_modalities, supports_streaming,
                        supports_tool_calling, supports_reasoning, pricing,
                        COALESCE(model_type, 'llm'), created_at, updated_at
                    FROM llm_models
                """))
                sync_conn.execute(text("DROP TABLE llm_models"))
                sync_conn.execute(text("ALTER TABLE llm_models_new RENAME TO llm_models"))
                sync_conn.execute(text("CREATE INDEX idx_llm_models_provider ON llm_models(provider_id)"))
                sync_conn.execute(text("CREATE INDEX idx_llm_models_user ON llm_models(user_id)"))
                sync_conn.execute(text("PRAGMA foreign_keys = ON"))
                logger.info("Migration: rebuilt llm_models (context_window/max_output_tokens now nullable, model_type added)")
                # Re-fetch columns after rebuild
                model_cols_info = {c['name']: c for c in inspector.get_columns('llm_models')}

            # Ensure model_type column exists (if table was not rebuilt)
            if 'model_type' not in model_cols_info:
                sync_conn.execute(text("ALTER TABLE llm_models ADD COLUMN model_type TEXT DEFAULT 'llm' NOT NULL"))
                logger.info("Migration: added llm_models.model_type")

            # Add is_default flag for default model selection
            if 'is_default' not in model_cols_info:
                sync_conn.execute(text("ALTER TABLE llm_models ADD COLUMN is_default INTEGER DEFAULT 0"))
                logger.info("Migration: added llm_models.is_default")

            # Batch infer existing model types
            result = sync_conn.execute(text(
                "SELECT id FROM llm_models WHERE model_type = 'llm'"
            )).fetchall()
            for (model_id,) in result:
                inferred = infer_model_type(model_id)
                if inferred != 'llm':
                    sync_conn.execute(
                        text("UPDATE llm_models SET model_type = :mt WHERE id = :id"),
                        {"mt": inferred, "id": model_id}
                    )
            if result:
                logger.info("Migration: batch inferred %d model types for existing models", len(result))

            # Clean deprecated settings
            sync_conn.execute(text(
                "DELETE FROM settings WHERE key IN ('embedding_model', 'image_gen', 'assistant_model')"
            ))
            logger.info("Migration: cleaned deprecated settings")
        await conn.run_sync(_migrate)
    logger.info("Platform tables ensured")
    t = _startup_log("platform tables + migrations", t)

    # 1.6 One-time cleanup: clear old agent config / messages / zvec / mind files
    await _run_agent_cleanup_once()
    t = _startup_log("agent cleanup", t)

    # 1.5 Provider YAML migration + sync
    from app.services.provider_migration import (
        migrate_from_legacy_config,
        sync_yaml_to_db,
    )
    mig_report = await migrate_from_legacy_config()
    if not mig_report.skipped:
        logger.info(
            "Provider migration: %s (providers=%d, models=%d)",
            mig_report.reason,
            mig_report.migrated_providers,
            mig_report.migrated_models,
        )
    async with AsyncSessionLocal() as db:
        sync_report = await sync_yaml_to_db(db)
        logger.info(
            "providers.yaml synced: %d providers, %d models, %d errors",
            sync_report.upserted_providers,
            sync_report.upserted_models,
            len(sync_report.errors),
        )
    t = _startup_log("provider migration/sync", t)

    # 1.7 Bootstrap built-in provider template when no providers exist
    async with AsyncSessionLocal() as db:
        await ensure_builtin_provider(db)
    t = _startup_log("builtin provider bootstrap", t)

    # 1.8 Encrypt any plaintext or legacy base64 API keys in DB / YAML
    async with AsyncSessionLocal() as db:
        key_mig = await migrate_plaintext_keys(db)
        if key_mig["db_encrypted"] or key_mig["yaml_encrypted"]:
            logger.info(
                "API key migration: %d DB keys, %d YAML keys encrypted",
                key_mig["db_encrypted"],
                key_mig["yaml_encrypted"],
            )
    t = _startup_log("api key migration", t)

    # 2. Engine infra
    cfg = load_config(_BACKEND_DIR / "engine" / "config.yaml")
    app.state.config = cfg
    t = _startup_log("load engine config", t)

    # Discover tools (inside local engine/)
    tools_dir = _BACKEND_DIR / "engine" / "tools"
    if tools_dir.exists():
        discovered = tool_registry.discover(str(tools_dir), package="engine.tools")
        logger.info("Discovered %d tool modules", len(discovered))
    else:
        logger.warning("Tools directory not found: %s", tools_dir)
    t = _startup_log("discover tools", t)

    # Install centralized permission hook (opencode-style toolchain).
    tool_registry.set_permission_checker(_tool_permission_checker)
    logger.info("Tool permission checker installed")

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
    t = _startup_log("inject comms callbacks", t)

    # Session store (connects to unified cloudmind.db)
    store = SessionStore()
    await store.connect()
    logger.info("SessionStore connected to unified DB")
    app.state.session_store = store

    from engine.context.vector_store import AgentMemoryStore

    memory_store = AgentMemoryStore()
    logger.info("AgentMemoryStore initialized (per-agent collections)")
    t = _startup_log("init session/memory stores", t)

    # Share with ws module
    _app_state["config"] = cfg
    _app_state["session_store"] = store
    _app_state["memory_store"] = memory_store

    # Start commission scheduler (Agent主动性: cron/interval任务)
    scheduler = get_scheduler()
    await scheduler.start()
    t = _startup_log("start commission scheduler", t)

    total = time.perf_counter() - _startup_start
    logger.info("[startup] lifespan complete: %.3fs", total)

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

app = FastAPI(
    title="CloudMind-Zome",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_load_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)

# Upload file serving (path traversal protection only, no auth)
app.add_api_route("/uploads/{path:path}", _serve_upload, methods=["GET"], include_in_schema=False)

# Routers
app.include_router(agents.router, prefix="/api/v1")
app.include_router(upload.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(groups.router, prefix="/api/v1")
app.include_router(actions.router, prefix="/api/v1")
app.include_router(approvals.router, prefix="/api/v1")
app.include_router(compute.router, prefix="/api/v1")
app.include_router(commissions.router, prefix="/api/v1")
app.include_router(config.router, prefix="/api/v1")
app.include_router(tools.router, prefix="/api/v1")
app.include_router(models_api.router, prefix="/api/v1")
app.include_router(user.router, prefix="/api/v1")
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
