"""Auth API: guest-only mode. No login/register required."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import DATA_DIR
from ..dependencies import get_db, require_user
from ..models import User, Profile

router = APIRouter(prefix="/auth", tags=["auth"])

_USERDATA_DIR = DATA_DIR / "userdata"
_USERDATA_DIR.mkdir(parents=True, exist_ok=True)


class AuthMeOut(BaseModel):
    code: int = 0
    data: dict


class ProfileUpdate(BaseModel):
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    radar: Optional[dict] = None


async def _get_or_create_profile(user_id: str, db: AsyncSession) -> Profile:
    result = await db.execute(select(Profile).where(Profile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if not profile:
        profile = Profile(user_id=user_id)
        db.add(profile)
        await db.commit()
        await db.refresh(profile)
    return profile


@router.get("/me", response_model=AuthMeOut)
async def me(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await _get_or_create_profile(user.id, db)
    return AuthMeOut(
        data={
            "user_id": user.id,
            "codename": user.codename,
            "nickname": user.nickname,
            "role": user.role,
            "level": user.level,
            "exp": user.exp,
            "avatar_url": user.avatar_url,
            "profile": {
                "bio": profile.profile_text or "",
                "quote": profile.quote or "",
                "tags": profile.tags or [],
                "radar": profile.radar or {},
            },
        }
    )


@router.put("/me", response_model=AuthMeOut)
async def update_me(
    body: ProfileUpdate,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    if body.nickname is not None:
        user.nickname = body.nickname
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url

    profile = await _get_or_create_profile(user.id, db)
    if body.radar is not None:
        profile.radar = body.radar

    await db.commit()
    await db.refresh(user)
    await db.refresh(profile)

    return AuthMeOut(
        data={
            "user_id": user.id,
            "codename": user.codename,
            "nickname": user.nickname,
            "role": user.role,
            "level": user.level,
            "exp": user.exp,
            "avatar_url": user.avatar_url,
            "profile": {
                "bio": profile.profile_text or "",
                "quote": profile.quote or "",
                "tags": profile.tags or [],
                "radar": profile.radar or {},
            },
        }
    )


# ------------------------------------------------------------------
# User self-defined profile (markdown)
# ------------------------------------------------------------------
class ProfileMdOut(BaseModel):
    code: int = 0
    data: dict


@router.get("/me/profile-md", response_model=ProfileMdOut)
async def get_profile_md(user: User = Depends(require_user)):
    """Read user's self-defined profile from userdata/profile.md."""
    path = _USERDATA_DIR / "profile.md"
    if not path.exists():
        return ProfileMdOut(data={"content": ""})
    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Read failed: {e}")
    return ProfileMdOut(data={"content": content})


class ProfileMdUpdate(BaseModel):
    content: str


@router.put("/me/profile-md", response_model=ProfileMdOut)
async def update_profile_md(
    body: ProfileMdUpdate,
    user: User = Depends(require_user),
):
    """Write user's self-defined profile to userdata/profile.md."""
    path = _USERDATA_DIR / "profile.md"
    try:
        path.write_text(body.content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Write failed: {e}")
    return ProfileMdOut(data={"updated": True})
