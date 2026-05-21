"""Database: single SQLite file for platform + engine tables.

WAL mode + foreign keys enabled. All tables coexist in cloudmind.db.
"""

from __future__ import annotations

from pathlib import Path
from typing import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import declarative_base

# ------------------------------------------------------------------
# Paths
# ------------------------------------------------------------------
DATA_DIR = Path.home() / ".cloudmind-zome"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "cloudmind.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

# ------------------------------------------------------------------
# Engine
# ------------------------------------------------------------------
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)

Base = declarative_base()


# ------------------------------------------------------------------
# SQLite pragmas on connect
# ------------------------------------------------------------------
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


# ------------------------------------------------------------------
# Dependency
# ------------------------------------------------------------------
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
