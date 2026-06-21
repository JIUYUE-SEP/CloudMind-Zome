"""FastAPI dependencies: DB session only (no auth).

CloudMind-Zome is a single-user local app; no login or authentication is needed.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
