"""SQLAlchemy base re-export.

All models use the same Base instance defined in app.database
to ensure metadata is unified.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from ..database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)
