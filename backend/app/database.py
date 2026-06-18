"""Database: single SQLite file for platform + engine tables.

WAL mode + foreign keys enabled. All tables coexist in cloudmind.db.
"""

from __future__ import annotations

import os
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
def _get_data_dir() -> Path:
    """Return the user-writable data directory.

    Tauri desktop builds set CLOUDMIND_DATA_DIR to the app-local data
    directory (e.g. ``%LOCALAPPDATA%\\com.cloudmind-zome.app``).  When
    unset, fall back to ``~/.cloudmind-zome`` for development mode.
    """
    env_dir = os.environ.get("CLOUDMIND_DATA_DIR")
    if env_dir:
        return Path(env_dir)
    return Path.home() / ".cloudmind-zome"


DATA_DIR = _get_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "cloudmind.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

# Agent workspace and other writable directories live under DATA_DIR.
WORKSPACE_ROOT = DATA_DIR / "workspace"
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ZVEC_DIR = DATA_DIR / "zvec"
ZVEC_DIR.mkdir(parents=True, exist_ok=True)

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
