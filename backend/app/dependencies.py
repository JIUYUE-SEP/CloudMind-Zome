"""FastAPI dependencies: DB session, auth (guest-only)."""

from __future__ import annotations

import os
import secrets
from typing import Optional

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal
from .models import User

SECRET_KEY = os.environ.get("CLOUDMIND_SECRET_KEY", secrets.token_hex(32))

# ------------------------------------------------------------------
# DB session
# ------------------------------------------------------------------
async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


# ------------------------------------------------------------------
# Auth (guest-only, no login required)
# ------------------------------------------------------------------
GUEST_CACHED_ID: str | None = None


async def require_user(db: AsyncSession = Depends(get_db)) -> User:
    """Return guest user. Auto-creates if not exists."""
    global GUEST_CACHED_ID
    if GUEST_CACHED_ID:
        result = await db.execute(select(User).where(User.id == GUEST_CACHED_ID))
        user = result.scalar_one_or_none()
        if user:
            return user

    result = await db.execute(select(User).where(User.codename == "guest"))
    guest = result.scalar_one_or_none()
    if guest:
        GUEST_CACHED_ID = guest.id
        return guest

    guest = User(
        id="00000000-0000-0000-0000-000000000000",
        codename="guest",
        nickname="访客",
        password_hash=None,
        device_id="guest-device",
        role="guest",
    )
    db.add(guest)
    await db.commit()
    await db.refresh(guest)
    GUEST_CACHED_ID = guest.id
    return guest


async def get_current_user(db: AsyncSession = Depends(get_db)) -> Optional[User]:
    """Same as require_user for compatibility."""
    return await require_user(db)
