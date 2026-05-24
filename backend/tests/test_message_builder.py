"""Unit tests for MessageBuilder."""

from __future__ import annotations

import pytest

from engine.message.types import Message, MessageMeta, TextBlock, ThinkingBlock, ToolResultBlock
from engine.agent.message_builder import MessageBuilder


def test_build_injects_personality():
    builder = MessageBuilder(
        personality_prompt="You are a helpful assistant.",
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    messages = builder.build([], scene_info="")
    assert len(messages) == 1
    assert messages[0].role == "system"
    assert "helpful assistant" in messages[0].get_text()


def test_build_injects_scene():
    builder = MessageBuilder(
        personality_prompt=None,
        agent_id="agent-1",
        agent_name="TestAgent",
    )
    messages = builder.build([], scene_info="当前场景：私聊")
    assert len(messages) == 1
    assert "私聊" in messages[0].get_text()
    assert "不要使用" in messages[0].get_text()


def test_build_adds_source_tags():
    builder = MessageBuilder(
        personality_prompt=None,
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
                source_name="私聊",
                sender_name="用户A",
            ),
        ),
    ]
    messages = builder.build(history, scene_info="")
    # system scene + user msg
    assert len(messages) == 1
    tagged = messages[0].get_text()
    assert "[05-24" in tagged or "[" in tagged  # timestamp prefix
    assert "用户A" in tagged
    assert "Hello" in tagged


def test_build_inserts_scene_separator():
    builder = MessageBuilder(
        personality_prompt=None,
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
    contents = [m.get_text() for m in messages]
    assert any("场景切换" in c for c in contents)


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
