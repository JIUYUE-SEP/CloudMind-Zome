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

from ..dependencies import get_db, require_user
from ..models import Agent, User

router = APIRouter(prefix="/agents", tags=["agents"])

# ------------------------------------------------------------------
# Upload storage
# ------------------------------------------------------------------
UPLOAD_DIR = Path.home() / ".cloudmind-zome" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


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


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    codename: Optional[str] = None
    capabilities: Optional[List[str]] = None
    aliases: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    represent_color: Optional[str] = None
    llm_config: Optional[dict] = None


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
    """List available LLM providers from ComputeProvider table."""
    from ..models import ComputeProvider
    result = await db.execute(
        select(ComputeProvider).where(
            ComputeProvider.user_id == user.id,
            ComputeProvider.status == "active",
        )
    )
    items = []
    for p in result.scalars().all():
        cfg = p.config or {}
        models = cfg.get("models", []) or []
        items.append({
            "id": p.id,
            "name": p.provider_type,
            "display_name": p.display_name,
            "models": models,
            "base_url": cfg.get("base_url", ""),
            "supports_streaming": True,
            "supports_vision": False,
            "supports_reasoning": False,
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
        "portrait_url": a.portrait_url,
        "model_url": a.model_url,
        "live2d_model_url": a.live2d_model_url,
        "represent_color": a.represent_color,
        "status": a.status,
        "created_at": a.created_at.isoformat() if a.created_at else "",
    })


@router.post("", response_model=ListResp)
async def create_agent(
    body: AgentCreate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
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
_MIND_DIR = Path.home() / ".cloudmind-zome" / "agents"


def _mind_path(agent_id: str, file: str) -> Path:
    return _MIND_DIR / agent_id / f"{file}.md"


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

    agent_dir = Path.home() / ".cloudmind-zome" / "agents" / agent_id
    text = build_personality_text(agent, agent_dir)

    model_cfg = dict(agent.model_config or {})
    marker_cfg = model_cfg.get("marker") or {}
    marker_provider_id = marker_cfg.get("provider_id")

    # Resolve credentials from ComputeProvider (app-layer has DB access)
    from ..models import ComputeProvider
    if marker_provider_id:
        prov_result = await db.execute(
            select(ComputeProvider).where(
                ComputeProvider.id == marker_provider_id,
                ComputeProvider.status == "active",
            ).limit(1)
        )
        prov = prov_result.scalars().first()
    else:
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
            import base64
            try:
                api_key = base64.b64decode(prov.api_key_encrypted.encode()).decode()
            except Exception:
                api_key = prov.api_key_encrypted
        model_cfg.setdefault("marker", {})
        model_cfg["marker"]["provider"] = marker_cfg.get("provider") or prov.provider_type
        model_cfg["marker"]["model"] = marker_cfg.get("model") or model_cfg.get("model") or "deepseek-chat"
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
_DB_PATH = Path.home() / ".cloudmind-zome" / "cloudmind.db"


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
