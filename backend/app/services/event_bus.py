"""Event bus / WebSocket connection manager.

Central hub for real-time message delivery. Both API layer (ws.py)
and service layer (workflow_engine.py) depend on this module, avoiding
circular imports.
"""

from __future__ import annotations

import logging
from typing import Dict

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manage active WebSocket connections."""

    def __init__(self):
        # user_id -> set of websockets
        self._connections: Dict[str, set[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self._connections.setdefault(user_id, set()).add(ws)
        logger.info("WS connected for user %s (total conns: %d)", user_id, len(self._connections[user_id]))

    def disconnect(self, user_id: str, ws: WebSocket):
        conns = self._connections.get(user_id)
        if conns:
            conns.discard(ws)
            if not conns:
                del self._connections[user_id]
        logger.info("WS disconnected for user %s", user_id)

    async def send_to_user(self, user_id: str, message: dict):
        conns = self._connections.get(user_id)
        if not conns:
            return
        dead = set()
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            conns.discard(ws)

    async def broadcast_to_session_members(self, session_members: list, message: dict):
        """Broadcast to all online user members of a session."""
        for m in session_members:
            if getattr(m, "member_type", None) == "user":
                await self.send_to_user(m.member_id, message)

    async def broadcast(self, message: dict):
        """Broadcast to all connected users."""
        dead = set()
        for user_id, conns in self._connections.items():
            for ws in conns:
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.add((user_id, ws))
        for user_id, ws in dead:
            self._connections.get(user_id, set()).discard(ws)


# Global singleton
manager = ConnectionManager()
