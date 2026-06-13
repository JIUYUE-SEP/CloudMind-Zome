"""Tests for QwenPaw import adapter."""
from __future__ import annotations

import json

from engine.importer.qwenpaw import QwenPawAdapter


class TestQwenPawAdapter:
    def test_platform_name(self):
        adapter = QwenPawAdapter()
        assert adapter.platform_name() == "qwenpaw"

    def test_parse_simple_text_message(self):
        adapter = QwenPawAdapter()
        line = json.dumps({
            "id": "msg-001",
            "name": "Alice",
            "role": "user",
            "timestamp": "2024-01-15T08:30:00Z",
            "content": [{"type": "text", "text": "Hello"}],
        })
        msgs = adapter.parse(line.encode("utf-8"))
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Hello"
        assert msgs[0]["message_uuid"] == "msg-001"
        assert msgs[0]["sender_name"] == "Alice"

    def test_parse_with_thinking(self):
        adapter = QwenPawAdapter()
        line = json.dumps({
            "id": "msg-002",
            "name": "Bot",
            "role": "assistant",
            "timestamp": 1705312200.0,
            "content": [
                {"type": "thinking", "thinking": "Let me think..."},
                {"type": "text", "text": "Done"},
            ],
        })
        msgs = adapter.parse(line.encode("utf-8"))
        assert len(msgs) == 1
        assert msgs[0]["role"] == "assistant"
        assert msgs[0]["reasoning_content"] == "Let me think..."
        assert msgs[0]["content"] == "Done"

    def test_parse_tool_use(self):
        adapter = QwenPawAdapter()
        line = json.dumps({
            "id": "msg-003",
            "name": "Bot",
            "role": "assistant",
            "timestamp": "2024-01-15T08:31:00+00:00",
            "content": [
                {"type": "tool_use", "id": "tu-1", "name": "read_file", "input": {"path": "/tmp/a"}},
            ],
        })
        msgs = adapter.parse(line.encode("utf-8"))
        assert len(msgs) == 1
        assert msgs[0]["tool_calls"] is not None
        assert "read_file" in msgs[0]["tool_calls"]
        assert msgs[0]["tool_name"] == "read_file"

    def test_parse_tool_result(self):
        adapter = QwenPawAdapter()
        line = json.dumps({
            "id": "msg-004",
            "name": "system",
            "role": "system",
            "timestamp": "2024-01-15T08:32:00Z",
            "content": [
                {"type": "tool_result", "tool_use_id": "tu-1", "content": "file content"},
            ],
        })
        msgs = adapter.parse(line.encode("utf-8"))
        assert len(msgs) == 1
        assert msgs[0]["role"] == "tool"
        assert msgs[0]["content"] == "file content"
        assert msgs[0]["tool_call_id"] == "tu-1"

    def test_parse_skips_invalid_lines(self):
        adapter = QwenPawAdapter()
        raw = b'not json\n' + json.dumps({"id": "x", "role": "user", "content": [{"type": "text", "text": "ok"}]}).encode() + b'\n'
        msgs = adapter.parse(raw)
        assert len(msgs) == 1
        assert msgs[0]["message_uuid"] == "x"

    def test_parse_multi_line(self):
        adapter = QwenPawAdapter()
        lines = [
            json.dumps({"id": "a", "role": "user", "content": [{"type": "text", "text": "hi"}]}),
            json.dumps({"id": "b", "role": "assistant", "content": [{"type": "text", "text": "hello"}]}),
        ]
        msgs = adapter.parse("\n".join(lines).encode())
        assert len(msgs) == 2
        assert msgs[0]["message_uuid"] == "a"
        assert msgs[1]["message_uuid"] == "b"
