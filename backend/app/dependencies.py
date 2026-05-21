"""FastAPI dependencies: DB session, auth, permissions."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal
from .models import User

# ------------------------------------------------------------------
# Config (dev-friendly; move to env in production)
# ------------------------------------------------------------------
import secrets, os

SECRET_KEY = os.environ.get("CLOUDMIND_SECRET_KEY", secrets.token_hex(32))
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

security = HTTPBearer(auto_error=False)


# ------------------------------------------------------------------
# DB session
# ------------------------------------------------------------------
async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


# ------------------------------------------------------------------
# Auth
# ------------------------------------------------------------------
async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> Optional[User]:
    """Return User instance or None (guest)."""
    if credentials is None or not credentials.credentials:
        return None
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            return None
    except JWTError:
        return None

    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def require_user(
    user: Optional[User] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Auth bypass for development: auto-create guest user if not logged in."""
    if user is not None:
        return user
    # Return/create a guest user so all APIs work without login
    result = await db.execute(select(User).where(User.codename == "guest"))
    guest = result.scalar_one_or_none()
    if guest:
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
    return guest


def create_access_token(user_id: str) -> str:
    return jwt.encode({"sub": user_id}, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None
