"""User profile API: read/write global user profile.md."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import DATA_DIR

router = APIRouter(prefix="/user", tags=["user"])

PROFILE_PATH = DATA_DIR / "userdata" / "profile.md"


class ProfileMdResp(BaseModel):
    code: int = 0
    data: dict


class ProfileMdUpdate(BaseModel):
    content: str


@router.get("/profile-md", response_model=ProfileMdResp)
async def get_profile_md():
    """Return the contents of the global user profile.md."""
    if not PROFILE_PATH.exists():
        return ProfileMdResp(data={"content": ""})
    try:
        content = PROFILE_PATH.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read profile: {exc}")
    return ProfileMdResp(data={"content": content})


@router.put("/profile-md", response_model=ProfileMdResp)
async def update_profile_md(body: ProfileMdUpdate):
    """Overwrite the global user profile.md."""
    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_PATH.write_text(body.content, encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write profile: {exc}")
    return ProfileMdResp(data={"content": body.content})
