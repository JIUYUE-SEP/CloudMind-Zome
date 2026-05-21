"""Auth API: register, login, me."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db, get_current_user, require_user, create_access_token
from ..models import User, Profile

router = APIRouter(prefix="/auth", tags=["auth"])


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------
class RegisterReq(BaseModel):
    nickname: str
    codename: str
    password: Optional[str] = None


class LoginReq(BaseModel):
    codename: str
    password: Optional[str] = None


class UserOut(BaseModel):
    user_id: str
    codename: str
    nickname: str
    role: str
    level: int
    exp: int
    avatar_url: str

    class Config:
        from_attributes = True


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


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _hash_password(pw: str) -> str:
    # Placeholder: use passlib in production
    import hashlib
    return hashlib.sha256(pw.encode()).hexdigest()


def _verify_password(pw: str, hashed: str) -> bool:
    return _hash_password(pw) == hashed


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.post("/register", response_model=AuthMeOut)
async def register(body: RegisterReq, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(User).where(User.codename == body.codename))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=422, detail="Codename already exists")

    user = User(
        id=str(uuid.uuid4()),
        codename=body.codename,
        nickname=body.nickname,
        password_hash=_hash_password(body.password) if body.password else None,
        device_id=str(uuid.uuid4()),
        role="user",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    token = create_access_token(user.id)
    return AuthMeOut(
        data={
            "user_id": user.id,
            "token": token,
            "expires_at": None,  # JWT self-contained; frontend checks exp if needed
        }
    )


@router.post("/login", response_model=AuthMeOut)
async def login(body: LoginReq, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.codename == body.codename))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid codename or password")

    if user.password_hash and not _verify_password(body.password or "", user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid codename or password")

    token = create_access_token(user.id)
    return AuthMeOut(
        data={
            "user_id": user.id,
            "token": token,
            "expires_at": None,
        }
    )


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
    user: Optional[User] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # If no token, load the guest user from DB so profile data persists across refreshes
    if user is None:
        result = await db.execute(select(User).where(User.codename == "guest"))
        user = result.scalar_one_or_none()
        if user is None:
            return AuthMeOut(
                data={
                    "user_id": None,
                    "codename": None,
                    "nickname": None,
                    "role": "guest",
                    "level": 0,
                    "exp": 0,
                    "avatar_url": "/uploads/avatars/default.png",
                    "profile": {"bio": "", "quote": "", "tags": [], "radar": {}},
                }
            )

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
