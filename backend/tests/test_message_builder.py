"""Unit tests for MessageBuilder."""

from __future__ import annotations

import pytest

from engine.message.types import Message, MessageMeta, TextBlock, ThinkingBlock, ToolResultBlock
from engine.agent.message_builder import MessageBuilder


def test_build_injects_mind_context():
    builder = MessageBuilder(
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    messages = builder.build([], scene_info="", mind_context="SOUL.md content here")
    assert len(messages) >= 2
    assert messages[0].role == "system"
    assert "你是 TestAgent" in messages[0].get_text()
    assert messages[1].role == "system"
    assert "SOUL.md" in messages[1].get_text()


def test_build_has_system_messages():
    builder = MessageBuilder(
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    messages = builder.build([], scene_info="")
    assert len(messages) == 3
    assert messages[0].role == "system"
    assert messages[1].role == "system"
    assert messages[2].role == "system"
    assert "你是 TestAgent" in messages[0].get_text()
    assert "行为指南" in messages[1].get_text()
    assert "记忆提示" in messages[2].get_text()


def test_build_adds_sender_prefix_for_group_chat():
    builder = MessageBuilder(
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    history = [
        Message(
            role="user",
            content="Hello",
            meta=MessageMeta(
                session_id="sess-1",
                timestamp=1716500000.0,
                source="group",
                source_name="测试群",
                sender_name="用户A",
            ),
        ),
    ]
    messages = builder.build(history, scene_info="")
    # 3 system messages + prefixed user msg
    assert len(messages) == 4
    assert messages[0].role == "system"
    assert messages[1].role == "system"
    assert messages[2].role == "system"
    assert messages[3].role == "user"
    tagged = messages[2].get_text()
    assert "用户A: " in tagged
    assert "Hello" in tagged


def test_build_preserves_history_order():
    builder = MessageBuilder(
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    history = [
        Message(
            role="user",
            content="msg1",
            meta=MessageMeta(session_id="sess-1", source_name="私聊"),
        ),
        Message(
            role="user",
            content="msg2",
            meta=MessageMeta(session_id="sess-2", source_name="群聊"),
        ),
    ]
    messages = builder.build(history, scene_info="")
    # 3 system messages + 2 history messages
    assert len(messages) == 5
    assert messages[0].role == "system"
    assert messages[1].role == "system"
    assert messages[2].role == "system"
    assert messages[3].role == "user"
    assert messages[4].role == "user"
    assert "msg1" in messages[2].get_text()
    assert "msg2" in messages[3].get_text()


def test_extract_text_only_skips_thinking():
    msg = Message(
        role="assistant",
        content=[
            ThinkingBlock(thinking="reasoning..."),
            TextBlock(text="actual reply"),
        ],
        meta=MessageMeta(),
    )
    text = MessageBuilder.extract_text_only(msg)
    assert "reasoning" not in text
    assert "actual reply" in text


def test_extract_shared_url_finds_image():
    msg = Message(
        role="tool",
        content=[ToolResultBlock(id="t1", content="[image:/uploads/shared/a.png]")],
        meta=MessageMeta(),
    )
    url = MessageBuilder.extract_shared_url(msg)
    assert url == "[image:/uploads/shared/a.png]"


def test_extract_shared_url_returns_none():
    msg = Message(
        role="tool",
        content=[ToolResultBlock(id="t1", content="plain text")],
        meta=MessageMeta(),
    )
    assert MessageBuilder.extract_shared_url(msg) is None
