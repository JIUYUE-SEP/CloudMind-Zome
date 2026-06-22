"""Agent (心智) CRUD API."""

from __future__ import annotations

import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import DATA_DIR, UPLOAD_DIR as _UPLOAD_DIR, WORKSPACE_ROOT
from ..dependencies import get_db

from engine.agent.data_store import AgentDataStore
from engine.agent.workspace import MindWorkspace

router = APIRouter(prefix="/agents", tags=["agents"])
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Upload storage
# ------------------------------------------------------------------
UPLOAD_DIR = _UPLOAD_DIR


def _save_upload(file: UploadFile, subfolder: str, max_size_mb: int = 50) -> str:
    # Size check (read up to limit + 1 bytes)
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > max_size_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {max_size_mb}MB")

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
    db: AsyncSession = Depends(get_db),
):
    from ..database import WORKSPACE_ROOT
    
    agents = []
    if WORKSPACE_ROOT.exists():
        for agent_dir in WORKSPACE_ROOT.iterdir():
            if agent_dir.is_dir():
                store = AgentDataStore(agent_dir.name)
                config = store.read_config()
                if config and config.get("status") != "deleted":
                    if search and search.lower() not in config.get("name", "").lower():
                        continue
                    agents.append({
                        "id": config["id"],
                        "name": config["name"],
                        "codename": config["codename"],
                        "status": config.get("status", "active"),
                        "portrait_url": config.get("portrait_url"),
                        "live2d_model_url": config.get("live2d_model_url"),
                        "model_url": config.get("model_url"),
                        "tags": config.get("tags", []),
                        "represent_color": config.get("represent_color", "#00E5C9"),
                        "created_at": config.get("created_at", ""),
                    })
    
    total = len(agents)
    start = (page - 1) * page_size
    end = start + page_size
    
    return ListResp(data={"items": agents[start:end], "total": total, "page": page, "page_size": page_size})


# ------------------------------------------------------------------
# Providers
# ------------------------------------------------------------------
@router.get("/providers", response_model=ListResp)
async def list_providers(
    db: AsyncSession = Depends(get_db),
):
    """List available LLM providers with full model details."""
    from ..models import ComputeProvider
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ComputeProvider)
        .where(
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
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    return ListResp(data=config)


@router.post("", response_model=ListResp)
async def create_agent(
    body: AgentCreate,
    db: AsyncSession = Depends(get_db),
):
    # Validate: embedder is required
    if not body.embedder_provider_id or not body.embedder_model_id:
        raise HTTPException(status_code=400, detail="Embedder provider and model are required")

    # Scan existing agents to generate unique codename
    from ..database import WORKSPACE_ROOT
    existing_codenames = []
    if WORKSPACE_ROOT.exists():
        for agent_dir in WORKSPACE_ROOT.iterdir():
            if agent_dir.is_dir():
                store = AgentDataStore(agent_dir.name)
                config = store.read_config()
                if config:
                    existing_codenames.append(config.get("codename", ""))
    
    codename = _gen_codename(existing_codenames)
    agent_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    
    # Create agent config as JSON document
    config = {
        "id": agent_id,
        "name": body.name,
        "codename": codename,
        "capabilities": body.capabilities or [],
        "aliases": body.aliases or [],
        "tags": body.tags or [],
        "represent_color": body.represent_color,
        "allowed_paths": body.allowed_paths or [],
        "toolsets": body.toolsets or [],
        "enabled_skills": body.enabled_skills or [],
        "provider_id": body.provider_id,
        "model_id": body.model_id,
        "temperature": body.temperature,
        "top_p": body.top_p,
        "marker_provider_id": body.marker_provider_id,
        "marker_model_id": body.marker_model_id,
        "embedder_provider_id": body.embedder_provider_id,
        "embedder_model_id": body.embedder_model_id,
        "compressor_provider_id": body.compressor_provider_id,
        "compressor_model_id": body.compressor_model_id,
        "imagegen_provider_id": body.imagegen_provider_id,
        "imagegen_model_id": body.imagegen_model_id,
        "fallback_chain": body.fallback_chain or [],
        "personality": body.personality or {},
        "max_context_tokens": body.max_context_tokens,
        "semantic_search_enabled": body.semantic_search_enabled,
        "image_generation_enabled": body.image_generation_enabled,
        "topic_compression_enabled": body.topic_compression_enabled,
        "status": "active",
        "role": "member",
        "created_at": now,
        "updated_at": now,
    }
    
    # Write to document store
    store = AgentDataStore(agent_id)
    store.ensure_dirs()
    store.write_config(config)

    # Initialize workspace files (markdown)
    try:
        MindWorkspace(agent_id).ensure_agent_workspace()
    except Exception as exc:
        logger.warning("Failed to initialize workspace for agent %s: %s", agent_id, exc)

    # Copy user profile.md to agent's USER.md as initial content
    try:
        profile_path = DATA_DIR / "userdata" / "profile.md"
        if profile_path.exists():
            workspace = MindWorkspace(agent_id)
            user_md_path = workspace.path("USER.md")
            profile_content = profile_path.read_text(encoding="utf-8")
            if profile_content.strip():
                user_md_path.write_text(profile_content, encoding="utf-8")
                logger.info("Copied profile.md to USER.md for agent %s", agent_id)
    except Exception as exc:
        logger.warning("Failed to copy profile.md to USER.md for agent %s: %s", agent_id, exc)

    return ListResp(data={
        "id": agent_id,
        "name": config["name"],
        "codename": config["codename"],
        "created_at": config["created_at"],
    })


@router.put("/{agent_id}", response_model=ListResp)
async def update_agent(
    agent_id: str,
    body: AgentUpdate,
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    updates = body.model_dump(exclude_unset=True)
    if "llm_config" in updates:
        updates["model_config"] = updates.pop("llm_config")
    
    store.update_config(updates)
    return ListResp(data={"id": agent_id, "updated": True})


@router.delete("/{agent_id}", response_model=ListResp)
async def delete_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    # Mark as deleted in config (soft delete)
    store.update_config({"status": "deleted", "deleted_at": datetime.now(timezone.utc).isoformat()})
    
    # Best-effort cleanup of agent vector memory and topic summaries
    try:
        from ..main import _app_state
        memory_store = _app_state.get("memory_store")
        if memory_store:
            memory_store.delete_agent(agent_id)
            memory_store.delete_agent_topics(agent_id)
    except Exception as exc:
        logger.warning("Failed to clean up vector memory for agent %s: %s", agent_id, exc)

    return ListResp(data={"deleted": True})


@router.post("/{agent_id}/portrait", response_model=ListResp)
async def upload_portrait(
    agent_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files allowed")

    url = _save_upload(file, "portraits")
    store.update_config({"portrait_url": url})

    return ListResp(data={"portrait_url": url})


@router.post("/{agent_id}/live2d", response_model=ListResp)
async def upload_live2d(
    agent_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    url = _save_upload(file, "live2d")
    store.update_config({"live2d_model_url": url})

    return ListResp(data={"live2d_model_url": url})


@router.post("/{agent_id}/model", response_model=ListResp)
async def upload_model(
    agent_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    allowed = {".vrm", ".glb", ".gltf", ".fbx", ".obj"}
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format. Allowed: {', '.join(allowed)}"
        )

    url = _save_upload(file, "models")
    store.update_config({"model_url": url})

    return ListResp(data={"model_url": url})


# ------------------------------------------------------------------
# Mind files (AGENTS.md / SOUL.md / PROFILE.md / MEMORY.md)
# ------------------------------------------------------------------
_MIND_FILE_MAP = {
    "AGENTS": "AGENTS.md",
    "AGENT": "AGENTS.md",
    "SOUL": "SOUL.md",
    "IDENTITY": "IDENTITY.md",
    "PROFILE": "PROFILE.md",
    "USER": "USER.md",
    "MEMORY": "MEMORY.md",
}
_MIND_FILES = set(_MIND_FILE_MAP.keys())


def _mind_path(agent_id: str, file: str) -> Path:
    from ..database import WORKSPACE_ROOT
    return WORKSPACE_ROOT / agent_id / _MIND_FILE_MAP[file]


@router.get("/{agent_id}/mind/{file}")
async def get_mind_file(
    agent_id: str,
    file: str,
    db: AsyncSession = Depends(get_db),
):
    """Read a mind file (AGENT/SOUL/PROFILE/MEMORY)."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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
async def put_mind_file(
    agent_id: str,
    file: str,
    body: MindFileUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Write a mind file (AGENT/SOUL/PROFILE/MEMORY)."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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
    db: AsyncSession = Depends(get_db),
):
    """Analyze agent personality from SOUL.md.

    Returns Big-5 scores. Does NOT save to DB — caller must PUT update.
    """
    import logging
    logger = logging.getLogger(__name__)

    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    from engine.personality.extractor import PersonalityExtractor, build_personality_text

    from ..database import WORKSPACE_ROOT
    agent_dir = WORKSPACE_ROOT / agent_id
    text = build_personality_text(config, agent_dir)

    model_cfg = dict(config.get("model_config") or {})

    # Prefer new independent fields; fallback to legacy model_config
    marker_provider_id = config.get("marker_provider_id") or (model_cfg.get("marker") or {}).get("provider_id")
    marker_model_id = config.get("marker_model_id") or (model_cfg.get("marker") or {}).get("model")

    if marker_provider_id:
        # Use provider_resolver (same lookup logic as new code path)
        from ..services.provider_resolver import resolve_provider_credentials
        creds = await resolve_provider_credentials(db, marker_provider_id, marker_model_id)
        if creds:
            model_cfg.setdefault("marker", {})
            model_cfg["marker"]["provider"] = creds.provider_type
            model_cfg["marker"]["model"] = creds.model_id or marker_model_id or "deepseek-chat"
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
            model_cfg.setdefault("marker", {})
            model_cfg["marker"]["provider"] = (model_cfg.get("marker") or {}).get("provider") or prov.provider_type
            model_cfg["marker"]["model"] = (model_cfg.get("marker") or {}).get("model") or model_cfg.get("model") or "deepseek-chat"
            model_cfg["marker"]["base_url"] = base_url

    try:
        extractor = await PersonalityExtractor.from_agent(db, config)
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
    db: AsyncSession = Depends(get_db),
):
    """Return topic summaries and compression stats for an agent."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    topics: list[dict] = []
    stats = {"total_messages": 0, "compressed_messages": 0, "compression_rate": 0.0}

    # Read from document store instead of SQLite
    memories = store.read_memories()
    stats["total_messages"] = len(memories)
    stats["compressed_messages"] = sum(1 for m in memories if m.get("compressed"))
    if stats["total_messages"] > 0:
        stats["compression_rate"] = round(
            stats["compressed_messages"] / stats["total_messages"] * 100, 1
        )

    return ListResp(data={"topics": topics, "stats": stats})


# ------------------------------------------------------------------
# Import conversation history
# ------------------------------------------------------------------
# Import conversation history
# ------------------------------------------------------------------
@router.post("/{agent_id}/import-history", response_model=ListResp)
async def import_history(
    agent_id: str,
    platform: str = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Import conversation history from an external platform JSONL file.

    Args:
        platform: Source platform name (e.g. "qwenpaw").
        file: JSONL file exported from the platform.

    Returns:
        { imported: N, skipped: M, errors: [...] }
    """
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    from engine.importer import get_adapter, list_platforms

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

    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    imported = 0
    skipped = 0
    errors: list[str] = []

    # Write to document store instead of SQLite
    for idx, msg in enumerate(messages):
        msg_uuid = msg.get("message_uuid", "")
        if not msg_uuid:
            skipped += 1
            continue
        
        store.append_memory({
            "agent_id": agent_id,
            "role": msg.get("role", "user"),
            "content": msg.get("content", ""),
            "tool_calls": msg.get("tool_calls"),
            "tool_name": msg.get("tool_name"),
            "reasoning_content": msg.get("reasoning_content"),
            "timestamp": msg.get("timestamp"),
            "token_count": msg.get("token_count"),
            "round": msg.get("round", 0),
            "compressed": msg.get("compressed", False),
            "message_uuid": msg_uuid,
            "tool_call_id": msg.get("tool_call_id"),
            "source": "imported",
            "source_id": "imported",
            "source_name": "",
            "sender_id": "",
            "sender_name": msg.get("sender_name", ""),
        })
        imported += 1

    return ListResp(
        data={"imported": imported, "skipped": skipped, "errors": errors}
    )


@router.get("/{agent_id}/import-platforms", response_model=ListResp)
async def list_import_platforms(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Return available import platforms."""
    from engine.importer import list_platforms

    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
        raise HTTPException(status_code=404, detail="Agent not found")

    return ListResp(data={"platforms": list_platforms()})


# ------------------------------------------------------------------
# Skill management
# ------------------------------------------------------------------
from engine.skill.loader import load_skills


@router.get("/{agent_id}/skills/discovered", response_model=ListResp)
async def list_discovered_skills(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Scan workspace/{agent_id}/skills/ and return all discovered SKILL.md files."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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
    db: AsyncSession = Depends(get_db),
):
    """Upload a SKILL.md file into workspace/{agent_id}/skills/{name}/SKILL.md.

    The skill name is extracted from the YAML frontmatter if present,
    otherwise falls back to the uploaded filename stem.
    """
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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
    db: AsyncSession = Depends(get_db),
):
    """Delete a skill directory from workspace/{agent_id}/skills/{skill_name}."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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

    """Delete a skill directory under workspace/{agent_id}/skills/{skill_name}."""
    store = AgentDataStore(agent_id)
    config = store.read_config()
    if not config or config.get("status") == "deleted":
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
