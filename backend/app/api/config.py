"""System configuration API: read / update engine/config.yaml.

GET returns raw values (including secrets) — this is a local single-user app.
PUT overwrites only the sections sent by the client.
"""

from __future__ import annotations

import copy
import logging
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..dependencies import require_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])

# ------------------------------------------------------------------
# Paths
# ------------------------------------------------------------------
_CFG_PATH = Path(__file__).resolve().parent.parent.parent / "engine" / "config.yaml"

# Whitelist of mutable top-level sections (safety)
_MUTABLE_SECTIONS = {
    "context",
    "tools",
    "tavily",
    "image_gen",
}

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _load_raw() -> dict[str, Any]:
    if not _CFG_PATH.exists():
        return {}
    with open(_CFG_PATH, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def _deep_merge(target: dict, source: dict) -> None:
    for k, v in source.items():
        if isinstance(v, dict) and k in target and isinstance(target[k], dict):
            _deep_merge(target[k], v)
        else:
            target[k] = v


def _save_raw(data: dict[str, Any]) -> None:
    _CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_CFG_PATH, "w", encoding="utf-8") as f:
        yaml.dump(data, f, allow_unicode=True, sort_keys=False, default_flow_style=False)


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class ConfigResp(BaseModel):
    code: int = 0
    data: dict = Field(default_factory=dict)


class ToolItem(BaseModel):
    name: str
    toolset: str
    safe_to_parallel: bool
    max_result_chars: int
    timeout: int | None


class ToolsResp(BaseModel):
    code: int = 0
    data: list[ToolItem] = Field(default_factory=list)


class UpdateConfigReq(BaseModel):
    context: dict | None = None
    tools: dict | None = None
    tavily: dict | None = None
    image_gen: dict | None = None


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@router.get("", response_model=ConfigResp)
async def get_config(user=Depends(require_user)):
    """Return raw config (secrets included — local single-user app)."""
    raw = _load_raw()
    return ConfigResp(data=raw)


@router.put("", response_model=ConfigResp)
async def update_config(body: UpdateConfigReq, user=Depends(require_user)):
    """Update allowed sections. Missing sections are left untouched."""
    try:
        old = _load_raw()
        updated = copy.deepcopy(old)

        payload = body.model_dump(exclude_unset=True)
        for section, value in payload.items():
            if section not in _MUTABLE_SECTIONS:
                continue
            if value is not None:
                if isinstance(value, dict) and isinstance(updated.get(section), dict):
                    _deep_merge(updated[section], value)
                else:
                    updated[section] = value

        _save_raw(updated)
        logger.info("Config updated by user %s", user.id)
        return ConfigResp(data=updated)
    except Exception as exc:
        logger.exception("Config update failed")
        return ConfigResp(code=500, data={"error": str(exc)})


@router.get("/tools", response_model=ToolsResp)
async def list_tools(user=Depends(require_user)):
    from engine.tool.registry import tool_registry

    items = []
    for name, info in tool_registry._tools.items():
        items.append(
            ToolItem(
                name=name,
                toolset=info.get("toolset", "default"),
                safe_to_parallel=info.get("safe_to_parallel", True),
                max_result_chars=info.get("max_result_chars", 12000),
                timeout=info.get("timeout"),
            )
        )
    return ToolsResp(data=items)
