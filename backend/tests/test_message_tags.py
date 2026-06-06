"""Tests for message tagging: private vs group chat sender prefix."""

from __future__ import annotations

import pytest

from engine.agent.message_builder import MessageBuilder
from engine.message.types import Message, MessageMeta


class TestSenderPrefix:
    def test_private_chat_no_prefix(self):
        builder = MessageBuilder(agent_id="a1", agent_name="Agent")
        history = [
            Message(
                role="user",
                content="hello",
                meta=MessageMeta(source="private", sender_name="User", source_name="私聊"),
            ),
        ]
        messages = builder.build(history, scene_info="")
        user_msg = [m for m in messages if m.role == "user"][0]
        assert user_msg.get_text() == "hello"
        assert "User:" not in user_msg.get_text()

    def test_group_chat_adds_sender_prefix(self):
        builder = MessageBuilder(agent_id="a1", agent_name="Agent")
        history = [
            Message(
                role="user",
                content="hello",
                meta=MessageMeta(source="group", sender_name="老王", source_name="测试群"),
            ),
        ]
        messages = builder.build(history, scene_info="")
        user_msg = [m for m in messages if m.role == "user"][0]
        assert user_msg.get_text() == "老王: hello"

    def test_group_chat_with_blocks(self):
        builder = MessageBuilder(agent_id="a1", agent_name="Agent")
        from engine.message.types import TextBlock
        history = [
            Message(
                role="user",
                content=[TextBlock(text="hi")],
                meta=MessageMeta(source="group", sender_name="Alice", source_name="群"),
            ),
        ]
        messages = builder.build(history, scene_info="")
        user_msg = [m for m in messages if m.role == "user"][0]
        assert "Alice: " in user_msg.get_text()
        assert "hi" in user_msg.get_text()

    def test_group_chat_empty_sender_uses_default(self):
        builder = MessageBuilder(agent_id="a1", agent_name="Agent")
        history = [
            Message(
                role="user",
                content="hello",
                meta=MessageMeta(source="group", sender_name="", source_name="群"),
            ),
        ]
        messages = builder.build(history, scene_info="")
        user_msg = [m for m in messages if m.role == "user"][0]
        assert "用户: hello" == user_msg.get_text()
