"""Message builder: source tagging, scene injection, history formatting.

Extracted from ReActAgent to reduce class complexity.
"""

from __future__ import annotations

import datetime as dt_mod
import re
from typing import Any

from ..message.types import (
    ContentBlock,
    ImageBlock,
    Message,
    MessageMeta,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)


class MessageBuilder:
    """Builds LLM message lists with personality, scene, and source tags."""

    def __init__(
        self,
        personality_prompt: str | None,
        agent_id: str,
        agent_name: str,
    ):
        self.personality_prompt = personality_prompt
        self.agent_id = agent_id
        self.agent_name = agent_name

    def build(
        self,
        history: list[Message],
        scene_info: str = "",
    ) -> list[Message]:
        """Build the message list for LLM call.

        Format:
          1. System: personality prompt (once per call)
          2. System: scene info (if provided) — injected every turn
          3. Conversation history with source tags [time | scene | sender]
        """
        result: list[Message] = []

        if self.personality_prompt:
            result.append(
                Message(
                    role="system",
                    content=self.personality_prompt,
                    meta=MessageMeta(session_id=self.agent_id),
                )
            )

        # Layer 2: Behavioral guidelines (injected every turn)
        result.append(
            Message(
                role="system",
                content=(
                    "【行为指南】\n"
                    "1. 对话历史中的 [时间 | 场景 | 人物] 标签是系统提供的上下文提示，"
                    "帮助你理解会话背景。你回复时不需要使用这个格式，直接输出自然、流畅的内容即可。\n"
                    "2. 当用户要求添加、修改或删除系统功能时，你拥有直接执行的能力。"
                    "先查看相关代码作为参考，然后直接调用工具修改。每完成一步向用户汇报。"
                    "不要把技术文档发给用户让用户自己操作。\n"
                    "3. 不确定如何修改时，可以先调用 list_project_docs 或 search_project_docs 查阅项目文档。"
                ),
                meta=MessageMeta(session_id=self.agent_id),
            )
        )

        if scene_info:
            result.append(
                Message(
                    role="system",
                    content=(
                        f"────\n{scene_info}\n────\n"
                        "不要使用 [日期 | 场景 | 人物] 的格式发送消息。"
                    ),
                    meta=MessageMeta(session_id=self.agent_id),
                )
            )

        prev_source_id: str | None = None
        for msg in history:
            if getattr(msg, "_smart_hint", False):
                result.append(msg)
                continue

            if getattr(msg.meta, "compressed", False):
                result.append(msg)
                continue

            cur_source_id = getattr(msg.meta, "session_id", "") or ""
            if prev_source_id is not None and cur_source_id != prev_source_id:
                result.append(
                    Message(
                        role="system",
                        content="── 场景切换 ──",
                        meta=MessageMeta(session_id=self.agent_id),
                    )
                )
            prev_source_id = cur_source_id

            if msg.role == "tool":
                result.append(msg)
            elif msg.role == "assistant" and any(
                isinstance(b, ToolUseBlock) for b in msg.content
            ):
                tagged_prefix = self._tag_prefix(msg)
                new_blocks: list[ContentBlock] = []
                for b in msg.content:
                    if isinstance(b, TextBlock):
                        new_blocks.append(
                            TextBlock(text=f"{tagged_prefix}\n{b.text}")
                        )
                    elif isinstance(b, ThinkingBlock):
                        new_blocks.append(b)
                    else:
                        new_blocks.append(b)
                result.append(
                    Message(role=msg.role, content=new_blocks, meta=msg.meta)
                )
            else:
                if any(isinstance(b, ImageBlock) for b in msg.content):
                    tagged_prefix = self._tag_prefix(msg)
                    new_blocks: list[ContentBlock] = []
                    for b in msg.content:
                        if isinstance(b, ImageBlock):
                            new_blocks.append(b)
                        elif isinstance(b, TextBlock):
                            new_blocks.append(
                                TextBlock(text=f"{tagged_prefix}\n{b.text}")
                            )
                    result.append(
                        Message(role=msg.role, content=new_blocks, meta=msg.meta)
                    )
                else:
                    tagged = self._tag_message(msg)
                    result.append(
                        Message(
                            role=msg.role,
                            content=tagged,
                            meta=msg.meta,
                        )
                    )

        return result

    def _tag_message(self, msg: Message) -> str:
        """Prefix a message with [time | scene | sender] tag."""
        tag = self._tag_prefix(msg)
        text = MessageBuilder.extract_text_only(msg)
        return f"{tag}\n{text}"

    def _tag_prefix(self, msg: Message) -> str:
        """Return just the [time | scene | sender] tag without message body."""
        ts = msg.meta.timestamp
        if isinstance(ts, (int, float)):
            time_str = dt_mod.datetime.fromtimestamp(
                ts, tz=dt_mod.timezone.utc
            ).strftime("%m-%d %H:%M")
        else:
            time_str = ""

        scene = msg.meta.source_name or msg.meta.source or "未知"

        sender = msg.meta.sender_name or msg.meta.sender_id
        if not sender:
            if msg.role == "assistant":
                sender = self.agent_name
            elif msg.role == "tool":
                sender = "系统"
            elif msg.role == "user":
                sender = "用户"
            else:
                sender = "系统"

        return f"[{time_str} | {scene} | {sender}]"

    @staticmethod
    def extract_text_only(msg: Message) -> str:
        """Get text content only, excluding ThinkingBlock (reasoning)."""
        parts: list[str] = []
        for b in msg.content:
            if isinstance(b, TextBlock):
                parts.append(b.text)
            elif isinstance(b, ToolResultBlock):
                parts.append(b.content)
        return "\n".join(parts)

    @staticmethod
    def extract_shared_url(msg: Message) -> str | None:
        """If a tool result contains [image:URL] or [file:URL], return it."""
        for b in msg.content:
            if isinstance(b, ToolResultBlock):
                m = re.search(r"\[(image|file):(/[^\]]+)\]", b.content)
                if m:
                    return f"[{m.group(1)}:{m.group(2)}]"
        return None
