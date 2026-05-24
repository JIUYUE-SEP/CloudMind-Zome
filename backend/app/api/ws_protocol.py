"""WebSocket protocol layer: frame building, stop signals, shared helpers."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Global stop signals for private chat interrupts
# Key: "{session_id}:{agent_id}" -> timestamp
# Only applies to private chat streams. TTL = 5 minutes.
# ------------------------------------------------------------------
_private_stop_signals: dict[str, float] = {}


def _set_stop_signal(signal_key: str) -> None:
    _private_stop_signals[signal_key] = datetime.now(timezone.utc).timestamp()
    # Prune stale entries (TTL 5 min)
    now = datetime.now(timezone.utc).timestamp()
    stale = [k for k, ts in _private_stop_signals.items() if now - ts > 300]
    for k in stale:
        _private_stop_signals.pop(k, None)


def _check_stop_signal(signal_key: str) -> bool:
    ts = _private_stop_signals.get(signal_key)
    if ts is None:
        return False
    now = datetime.now(timezone.utc).timestamp()
    if now - ts > 300:
        _private_stop_signals.pop(signal_key, None)
        return False
    return True


def _clear_stop_signal(signal_key: str) -> None:
    _private_stop_signals.pop(signal_key, None)


def _build_ws_frame(msg_type: str, payload: dict) -> dict:
    return {
        "type": msg_type,
        "id": f"evt_{uuid.uuid4().hex[:12]}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


def _engine_state() -> dict:
    from ..main import _app_state
    return _app_state
