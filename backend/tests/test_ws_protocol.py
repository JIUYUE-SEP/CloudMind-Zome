"""Unit tests for ws_protocol helpers."""

from __future__ import annotations

import pytest

from app.api.ws_protocol import (
    _build_ws_frame,
    _check_stop_signal,
    _clear_stop_signal,
    _set_stop_signal,
)


def test_build_ws_frame_structure():
    frame = _build_ws_frame("chat.message", {"text": "hi"})
    assert frame["type"] == "chat.message"
    assert "id" in frame
    assert "timestamp" in frame
    assert frame["payload"]["text"] == "hi"


def test_stop_signal_lifecycle():
    key = "sess:agent"
    # Initially false
    assert _check_stop_signal(key) is False

    # Set
    _set_stop_signal(key)
    assert _check_stop_signal(key) is True

    # Clear
    _clear_stop_signal(key)
    assert _check_stop_signal(key) is False
