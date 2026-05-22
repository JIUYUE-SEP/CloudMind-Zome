"""Auth API: guest-only mode. No login/register required."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, require_user
from ..models import User, Profile

router = APIRouter(prefix="/auth", tags=["auth"])


class AuthMeOut(BaseModel):
    code: int = 0
    data: dict


class ProfileUpdate(BaseModel):
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    bio: Optional[str] = None
    quote: Optional[str] = None
    tags: Optional[list] = None
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
    if body.bio is not None:
        profile.profile_text = body.bio
    if body.quote is not None:
        profile.quote = body.quote
    if body.tags is not None:
        profile.tags = body.tags
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
