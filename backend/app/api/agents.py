"""Agent (心智) CRUD API."""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import DATA_DIR, UPLOAD_DIR as _UPLOAD_DIR
from ..dependencies import get_db, require_user
from ..models import Agent, User
from app.core.crypto import decrypt_value

router = APIRouter(prefix="/agents", tags=["agents"])

# ------------------------------------------------------------------
# Upload storage
# ------------------------------------------------------------------
UPLOAD_DIR = _UPLOAD_DIR


def _save_upload(file: UploadFile, subfolder: str) -> str:
    ext = Path(file.filename or "file").suffix
    filename = f"{uuid.uuid4().hex}{ext}"
    folder = UPLOAD_DIR / subfolder
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return f"/uploads/{subfolder}/{filename}"


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class AgentCreate(BaseModel):
    name: str
    capabilities: List[str] = Field(default_factory=list)
    aliases: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    represent_color: str = "#00E5C9"
    llm_config: dict = Field(default_factory=dict)
    allowed_paths: List[str] = Field(default_factory=list)
    toolsets: List[str] = Field(default_factory=list)
    enabled_skills: List[str] = Field(default_factory=list)
    # New independent provider/model fields (batch 2)
    provider_id: Optional[str] = None
    model_id: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    marker_provider_id: Optional[str] = None
    marker_model_id: Optional[str] = None
    embedder_provider_id: Optional[str] = None
    embedder_model_id: Optional[str] = None
    compressor_provider_id: Optional[str] = None
    compressor_model_id: Optional[str] = None
    imagegen_provider_id: Optional[str] = None
    imagegen_model_id: Optional[str] = None
    fallback_chain: Optional[List[dict]] = None
    personality: Optional[dict] = None
    max_context_tokens: Optional[int] = None
    semantic_search_enabled: Optional[bool] = True
    image_generation_enabled: Optional[bool] = True
    topic_compression_enabled: Optional[bool] = True


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    codename: Optional[str] = None
    capabilities: Optional[List[str]] = None
    aliases: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    represent_color: Optional[str] = None
    llm_config: Optional[dict] = None
    allowed_paths: Optional[List[str]] = None
    toolsets: Optional[List[str]] = None
    enabled_skills: Optional[List[str]] = None
    # New independent provider/model fields (batch 2)
    provider_id: Optional[str] = None
    model_id: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    marker_provider_id: Optional[str] = None
    marker_model_id: Optional[str] = None
    embedder_provider_id: Optional[str] = None
    embedder_model_id: Optional[str] = None
    compressor_provider_id: Optional[str] = None
    compressor_model_id: Optional[str] = None
    imagegen_provider_id: Optional[str] = None
    imagegen_model_id: Optional[str] = None
    fallback_chain: Optional[List[dict]] = None
    personality: Optional[dict] = None
    max_context_tokens: Optional[int] = None
    semantic_search_enabled: Optional[bool] = True
    image_generation_enabled: Optional[bool] = True
    topic_compression_enabled: Optional[bool] = True


class AgentListItem(BaseModel):
    id: str
    name: str
    codename: str
    status: str
    portrait_url: Optional[str]
    live2d_model_url: Optional[str]
    model_url: Optional[str]
    tags: List[str] = []
    represent_color: str
    created_at: str

    class Config:
        from_attributes = True


class AgentDetail(AgentListItem):
    memory_count: int = 0
    capabilities: List[str]
    llm_config: dict
    appearance: dict = Field(default_factory=dict)


class ListResp(BaseModel):
    code: int = 0
    data: Any = {}


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _gen_codename(existing: List[str]) -> str:
    nums = []
    for c in existing:
        if c.startswith("CM-"):
            try:
                nums.append(int(c.split("-")[1]))
            except ValueError:
                pass
    n = max(nums, default=0) + 1
    return f"CM-{n:02d}"


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("", response_model=ListResp)
async def list_agents(
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Agent).where(Agent.user_id == user.id, Agent.deleted_at.is_(None))
    if search:
        stmt = stmt.where(Agent.name.ilike(f"%{search}%"))

    count_result = await db.execute(select(Agent.id).where(Agent.user_id == user.id, Agent.deleted_at.is_(None)))
    total = len(count_result.scalars().all())

    result = await db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    items = []
    for a in result.scalars().all():
        items.append({
            "id": a.id,
            "name": a.name,
            "codename": a.codename,
            "status": a.status,
            "portrait_url": a.portrait_url,
            "live2d_model_url": a.live2d_model_url,
            "model_url": a.model_url,
            "tags": a.tags or [],
            "represent_color": a.represent_color,
            "created_at": a.created_at.isoformat() if a.created_at else "",
        })

    return ListResp(data={"items": items, "total": total, "page": page, "page_size": page_size})


# ------------------------------------------------------------------
# Providers
# ------------------------------------------------------------------
@router.get("/providers", response_model=ListResp)
async def list_providers(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """List available LLM providers with full model details."""
    from ..models import ComputeProvider, LLMModel
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ComputeProvider)
        .where(
            ComputeProvider.user_id == user.id,
            ComputeProvider.status == "active",
        )
        .options(selectinload(ComputeProvider.models))
    )
    items = []
    for p in result.scalars().all():
        model_objs = []
        for m in p.models:
            if m.status != "active":
                continue
            model_objs.append({
                "id": m.id.split("::")[-1],
                "display_name": m.display_name,
                "model_type": m.model_type,
                "context_window": m.context_window,
                "max_output_tokens": m.max_output_tokens,
                "supports_multimodal": m.supports_multimodal,
                "supports_streaming": m.supports_streaming,
                "supports_tool_calling": m.supports_tool_calling,
                "supports_reasoning": m.supports_reasoning,
            })
        items.append({
            "id": p.id,
            "provider_type": p.provider_type,
            "display_name": p.display_name,
            "models": model_objs,
            "base_url": p.base_url or (p.config or {}).get("base_url", ""),
            "supports_streaming": True,
        })
    return ListResp(data=items)


@router.get("/{agent_id}", response_model=ListResp)
async def get_agent(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    a = result.scalar_one_or_none()
    if not a:
        raise HTTPException(status_code=404, detail="Agent not found")

    return ListResp(data={
        "id": a.id,
        "name": a.name,
        "codename": a.codename,
        "memory_count": 0,
        "capabilities": a.capabilities or [],
        "aliases": a.aliases or [],
        "tags": a.tags or [],
        "llm_config": a.model_config or {},
        "allowed_paths": a.allowed_paths or [],
        "toolsets": a.toolsets or [],
        "enabled_skills": a.enabled_skills or [],
        "portrait_url": a.portrait_url,
        "model_url": a.model_url,
        "live2d_model_url": a.live2d_model_url,
        "represent_color": a.represent_color,
        "status": a.status,
        "created_at": a.created_at.isoformat() if a.created_at else "",
        # New independent provider/model fields
        "provider_id": a.provider_id,
        "model_id": a.model_id,
        "temperature": a.temperature,
        "top_p": a.top_p,
        "marker_provider_id": a.marker_provider_id,
        "marker_model_id": a.marker_model_id,
        "embedder_provider_id": a.embedder_provider_id,
        "embedder_model_id": a.embedder_model_id,
        "compressor_provider_id": a.compressor_provider_id,
        "compressor_model_id": a.compressor_model_id,
        "imagegen_provider_id": a.imagegen_provider_id,
        "imagegen_model_id": a.imagegen_model_id,
        "fallback_chain": a.fallback_chain or [],
        "personality": a.personality or {},
        "max_context_tokens": a.max_context_tokens,
        "semantic_search_enabled": a.semantic_search_enabled,
        "image_generation_enabled": a.image_generation_enabled,
        "topic_compression_enabled": a.topic_compression_enabled,
    })


@router.post("", response_model=ListResp)
async def create_agent(
    body: AgentCreate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate: embedder is required
    if not body.embedder_provider_id or not body.embedder_model_id:
        raise HTTPException(status_code=400, detail="Embedder provider and model are required")

    existing = await db.execute(select(Agent.codename).where(Agent.user_id == user.id))
    codenames = [r for r in existing.scalars().all()]
    codename = _gen_codename(codenames)

    agent = Agent(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=body.name,
        codename=codename,
        capabilities=body.capabilities,
        aliases=body.aliases,
        tags=body.tags,
        represent_color=body.represent_color,
        model_config=body.llm_config,
        allowed_paths=body.allowed_paths,
        toolsets=body.toolsets,
        enabled_skills=body.enabled_skills,
        # New independent provider/model fields
        provider_id=body.provider_id,
        model_id=body.model_id,
        temperature=body.temperature,
        top_p=body.top_p,
        marker_provider_id=body.marker_provider_id,
        marker_model_id=body.marker_model_id,
        embedder_provider_id=body.embedder_provider_id,
        embedder_model_id=body.embedder_model_id,
        compressor_provider_id=body.compressor_provider_id,
        compressor_model_id=body.compressor_model_id,
        imagegen_provider_id=body.imagegen_provider_id,
        imagegen_model_id=body.imagegen_model_id,
        fallback_chain=body.fallback_chain,
        personality=body.personality,
        max_context_tokens=body.max_context_tokens,
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)

    return ListResp(data={
        "id": agent.id,
        "name": agent.name,
        "codename": agent.codename,
        "created_at": agent.created_at.isoformat() if agent.created_at else "",
    })


@router.put("/{agent_id}", response_model=ListResp)
async def update_agent(
    agent_id: str,
    body: AgentUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "llm_config":
            field = "model_config"
        setattr(agent, field, value)

    await db.commit()
    await db.refresh(agent)
    return ListResp(data={"id": agent.id, "updated": True})


@router.delete("/{agent_id}", response_model=ListResp)
async def delete_agent(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    from datetime import datetime, timezone
    agent.deleted_at = datetime.now(timezone.utc)

    if user.poster_agent_id == agent_id:
        user.poster_agent_id = None

    await db.commit()
    return ListResp(data={"deleted": True})


@router.post("/{agent_id}/portrait", response_model=ListResp)
async def upload_portrait(
    agent_id: str,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files allowed")

    url = _save_upload(file, "portraits")
    agent.portrait_url = url
    await db.commit()

    return ListResp(data={"portrait_url": url})


@router.post("/{agent_id}/live2d", response_model=ListResp)
async def upload_live2d(
    agent_id: str,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    url = _save_upload(file, "live2d")
    agent.live2d_model_url = url
    await db.commit()

    return ListResp(data={"live2d_model_url": url})


@router.post("/{agent_id}/model", response_model=ListResp)
async def upload_model(
    agent_id: str,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    allowed = {".vrm", ".glb", ".gltf", ".fbx", ".obj"}
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Allowed: {', '.join(allowed)}"
        )

    url = _save_upload(file, "models")
    agent.model_url = url
    await db.commit()

    return ListResp(data={"model_url": url})


# ------------------------------------------------------------------
# Mind files (AGENT.md / SOUL.md / PROFILE.md / MEMORY.md)
# ------------------------------------------------------------------
_MIND_FILES = {"AGENT", "SOUL", "USER", "MEMORY"}


def _mind_path(agent_id: str, file: str) -> Path:
    from ..database import WORKSPACE_ROOT
    return WORKSPACE_ROOT / agent_id / f"{file}.md"


@router.get("/{agent_id}/mind/{file}")
async def get_mind_file(
    agent_id: str,
    file: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Read a mind file (AGENT/SOUL/PROFILE/MEMORY)."""
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    if file not in _MIND_FILES:
        raise HTTPException(status_code=400, detail=f"Invalid file. Allowed: {', '.join(_MIND_FILES)}")

    path = _mind_path(agent_id, file)
    if not path.exists():
        return ListResp(data={"content": ""})

    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Read failed: {e}")

    return ListResp(data={"content": content})


class MindFileUpdate(BaseModel):
    content: str


@router.put("/{agent_id}/mind/{file}")
async def update_mind_file(
    agent_id: str,
    file: str,
    body: MindFileUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Write a mind file (AGENT/SOUL/PROFILE/MEMORY)."""
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    if file not in _MIND_FILES:
        raise HTTPException(status_code=400, detail=f"Invalid file. Allowed: {', '.join(_MIND_FILES)}")

    path = _mind_path(agent_id, file)
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        path.write_text(body.content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Write failed: {e}")

    return ListResp(data={"updated": True})


# ------------------------------------------------------------------
# Personality analysis
# ------------------------------------------------------------------
@router.post("/{agent_id}/analyze-personality", response_model=ListResp)
async def analyze_agent_personality(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Analyze agent personality from SOUL.md.

    Returns Big-5 scores. Does NOT save to DB — caller must PUT update.
    """
    import logging
    logger = logging.getLogger(__name__)

    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    from engine.personality.extractor import PersonalityExtractor, build_personality_text

    from ..database import WORKSPACE_ROOT
    agent_dir = WORKSPACE_ROOT / agent_id
    text = build_personality_text(agent, agent_dir)

    model_cfg = dict(agent.model_config or {})

    # Prefer new independent fields; fallback to legacy model_config
    marker_provider_id = agent.marker_provider_id or (model_cfg.get("marker") or {}).get("provider_id")
    marker_model_id = agent.marker_model_id or (model_cfg.get("marker") or {}).get("model")

    if marker_provider_id:
        # Use provider_resolver (same lookup logic as new code path)
        from ..services.provider_resolver import resolve_provider_credentials
        creds = await resolve_provider_credentials(db, marker_provider_id, marker_model_id)
        if creds:
            model_cfg.setdefault("marker", {})
            model_cfg["marker"]["provider"] = creds.provider_type
            model_cfg["marker"]["model"] = creds.model_id or marker_model_id or "deepseek-chat"
            model_cfg["marker"]["api_key"] = creds.api_key or ""
            model_cfg["marker"]["base_url"] = creds.base_url
    else:
        # Legacy fallback path (kept for backward compat, will be cleaned in batch 4)
        from ..models import ComputeProvider
        main_provider_id = model_cfg.get("provider_id")
        prov_result = await db.execute(
            select(ComputeProvider).where(
                ComputeProvider.id == main_provider_id,
                ComputeProvider.status == "active",
            ).limit(1)
        )
        prov = prov_result.scalars().first()
        if not prov:
            prov_result = await db.execute(
                select(ComputeProvider).where(
                    ComputeProvider.provider_type == (model_cfg.get("provider") or "deepseek"),
                    ComputeProvider.status == "active",
                ).limit(1)
            )
            prov = prov_result.scalars().first()
        if prov:
            base_url = (prov.config or {}).get("base_url", "")
            api_key = ""
            if prov.api_key_encrypted:
                try:
                    api_key = decrypt_value(prov.api_key_encrypted)
                except Exception:
                    api_key = prov.api_key_encrypted
            model_cfg.setdefault("marker", {})
            model_cfg["marker"]["provider"] = (model_cfg.get("marker") or {}).get("provider") or prov.provider_type
            model_cfg["marker"]["model"] = (model_cfg.get("marker") or {}).get("model") or model_cfg.get("model") or "deepseek-chat"
            model_cfg["marker"]["api_key"] = api_key
            model_cfg["marker"]["base_url"] = base_url

    try:
        extractor = PersonalityExtractor.from_marker_config(model_cfg)
        personality = await extractor.analyze(text)
    except Exception as e:
        logger.warning("Personality analysis failed for %s: %s", agent_id, e)
        personality = {
            "extraversion": 0.5,
            "talkativeness": 0.5,
            "reactiveness": 0.5,
            "agreeableness": 0.5,
            "emotional_stability": 0.5,
        }

    return ListResp(data={
        "personality": personality,
        "source": "SOUL.md",
        "auto": True,
    })


# ------------------------------------------------------------------
# Agent memory state (topics + compression stats)
# ------------------------------------------------------------------
_DB_PATH = DATA_DIR / "cloudmind.db"


@router.get("/{agent_id}/memory", response_model=ListResp)
async def get_agent_memory(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return topic summaries and compression stats for an agent."""
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    topics: list[dict] = []
    stats = {"total_messages": 0, "compressed_messages": 0, "compression_rate": 0.0}

    async with aiosqlite.connect(str(_DB_PATH)) as engine_db:
        # Topics: try agent_id as session_id first, then pattern match
        try:
            async with engine_db.execute(
                """
                SELECT id, name, subtopic_name, importance, summary,
                       start_round, end_round, updated_at
                FROM llm_topics
                WHERE session_id = ? OR session_id LIKE ?
                ORDER BY updated_at DESC
                LIMIT 50
                """,
                (agent_id, f"%:{agent_id}"),
            ) as cur:
                rows = await cur.fetchall()
                for row in rows:
                    topics.append({
                        "id": row[0],
                        "name": row[1],
                        "subtopic_name": row[2],
                        "importance": row[3],
                        "summary": row[4],
                        "start_round": row[5],
                        "end_round": row[6],
                        "updated_at": row[7],
                    })
        except aiosqlite.OperationalError:
            # llm_topics may not exist yet (lazy creation)
            pass

        # Stats from agent_messages
        try:
            async with engine_db.execute(
                """
                SELECT COUNT(*), SUM(CASE WHEN compressed = 1 THEN 1 ELSE 0 END)
                FROM agent_messages WHERE agent_id = ?
                """,
                (agent_id,),
            ) as cur:
                row = await cur.fetchone()
                if row:
                    stats["total_messages"] = row[0] or 0
                    stats["compressed_messages"] = row[1] or 0
                    if stats["total_messages"] > 0:
                        stats["compression_rate"] = round(
                            stats["compressed_messages"] / stats["total_messages"] * 100, 1
                        )
        except aiosqlite.OperationalError:
            # agent_messages may not exist yet (engine not initialized)
            pass

    return ListResp(data={"topics": topics, "stats": stats})


# ------------------------------------------------------------------
# Import conversation history
# ------------------------------------------------------------------


class ImportHistoryResp(BaseModel):
    code: int = 0
    data: Any = {}


@router.post("/{agent_id}/import-history", response_model=ListResp)
async def import_history(
    agent_id: str,
    platform: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Import conversation history from an external platform JSONL file.

    Args:
        platform: Source platform name (e.g. "qwenpaw").
        file: JSONL file exported from the platform.

    Returns:
        { imported: N, skipped: M, errors: [...] }
    """
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    from engine.importer import get_adapter

    adapter = get_adapter(platform)
    if adapter is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported platform '{platform}'. Supported: {', '.join(list_platforms())}"
        )

    content = await file.read()
    try:
        messages = adapter.parse(content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Parse failed: {e}")

    if not messages:
        return ListResp(data={"imported": 0, "skipped": 0, "errors": ["No valid messages found"]})

    # Connect to unified DB
    db_path = DATA_DIR / "cloudmind.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)

    imported = 0
    skipped = 0
    errors: list[str] = []

    async with aiosqlite.connect(str(db_path)) as conn:
        # Ensure table exists (same schema as SessionStore)
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                tool_name TEXT,
                reasoning_content TEXT,
                timestamp REAL NOT NULL,
                token_count INTEGER,
                round INTEGER,
                compressed INTEGER DEFAULT 0,
                message_uuid TEXT,
                source TEXT NOT NULL DEFAULT 'private',
                source_id TEXT,
                source_name TEXT,
                sender_id TEXT,
                sender_name TEXT
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_msgs_agent ON agent_messages(agent_id)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_msgs_source ON agent_messages(source, agent_id)"
        )

        # Fetch existing UUIDs for deduplication
        cursor = await conn.execute(
            "SELECT message_uuid FROM agent_messages WHERE agent_id = ? AND message_uuid IS NOT NULL",
            (agent_id,),
        )
        existing_uuids = {row[0] for row in await cursor.fetchall()}

        # Build insert batch
        insert_rows = []
        for idx, msg in enumerate(messages):
            msg_uuid = msg.get("message_uuid", "")
            if not msg_uuid or msg_uuid in existing_uuids:
                skipped += 1
                continue
            existing_uuids.add(msg_uuid)

            ts_raw = msg.get("timestamp")
            try:
                from datetime import datetime, timezone
                if isinstance(ts_raw, str):
                    ts_str = ts_raw.replace("Z", "+00:00")
                    dt = datetime.fromisoformat(ts_str)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    ts_val = dt.timestamp()
                else:
                    ts_val = float(ts_raw or 0)
            except Exception:
                ts_val = 0.0

            insert_rows.append(
                (
                    agent_id,
                    msg.get("role", "user"),
                    msg.get("content", ""),
                    msg.get("tool_calls"),
                    msg.get("tool_name"),
                    msg.get("reasoning_content"),
                    ts_val,
                    msg.get("token_count"),
                    msg.get("round", 0),
                    1 if msg.get("compressed") else 0,
                    msg_uuid,
                    msg.get("tool_call_id"),
                    "imported",          # source
                    "imported",          # source_id
                    "",                  # source_name
                    "",                  # sender_id
                    msg.get("sender_name", ""),
                )
            )

        # Batch insert
        if insert_rows:
            await conn.executemany(
                """
                INSERT INTO agent_messages
                (agent_id, role, content, tool_calls, tool_name, reasoning_content,
                 timestamp, token_count, round, compressed, message_uuid, tool_call_id,
                 source, source_id, source_name, sender_id, sender_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                insert_rows,
            )
            await conn.commit()
            imported = len(insert_rows)

    return ListResp(
        data={"imported": imported, "skipped": skipped, "errors": errors}
    )


@router.get("/{agent_id}/import-platforms", response_model=ListResp)
async def list_import_platforms(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return available import platforms."""
    from engine.importer import list_platforms

    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    return ListResp(data={"platforms": list_platforms()})


# ------------------------------------------------------------------
# Skill management
# ------------------------------------------------------------------
from engine.skill.loader import load_skills


@router.get("/{agent_id}/skills/discovered", response_model=ListResp)
async def list_discovered_skills(
    agent_id: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Scan workspace/{agent_id}/skills/ and return all discovered SKILL.md files."""
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    skills = load_skills(agent_id)
    return ListResp(
        data=[
            {"name": s.name, "description": s.description, "path": s.path}
            for s in skills
        ]
    )


@router.post("/{agent_id}/skills/upload", response_model=ListResp)
async def upload_skill(
    agent_id: str,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a SKILL.md file into workspace/{agent_id}/skills/{name}/SKILL.md.

    The skill name is extracted from the YAML frontmatter if present,
    otherwise falls back to the uploaded filename stem.
    """
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    if file.filename and not file.filename.lower().endswith(".md"):
        raise HTTPException(status_code=400, detail="Only .md files are allowed")

    content = await file.read()
    text = content.decode("utf-8", errors="replace")

    name = ""
    try:
        import yaml
        front_text = ""
        stripped = text.strip()
        if stripped.startswith("---"):
            parts = stripped.split("---", 2)
            if len(parts) >= 3:
                front_text = parts[1].strip()
        if front_text:
            meta = yaml.safe_load(front_text) or {}
            if isinstance(meta, dict):
                name = meta.get("name", "")
    except Exception:
        pass

    if not name:
        name = Path(file.filename or "skill").stem

    if not name or ".." in name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid skill name")

    from ..database import WORKSPACE_ROOT
    skill_dir = WORKSPACE_ROOT / agent_id / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    dest = skill_dir / "SKILL.md"
    dest.write_text(text, encoding="utf-8")

    return ListResp(data={"name": name, "path": str(dest)})


@router.delete("/{agent_id}/skills/{skill_name}", response_model=ListResp)
async def delete_skill(
    agent_id: str,
    skill_name: str,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a skill directory under workspace/{agent_id}/skills/{skill_name}."""
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.user_id == user.id, Agent.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

    if not skill_name or ".." in skill_name or "/" in skill_name or "\\" in skill_name:
        raise HTTPException(status_code=400, detail="Invalid skill name")

    from ..database import WORKSPACE_ROOT
    skill_dir = WORKSPACE_ROOT / agent_id / "skills" / skill_name
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail="Skill not found")

    import shutil
    shutil.rmtree(skill_dir)
    return ListResp(data={"deleted": True})
