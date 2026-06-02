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
    """Builds LLM message lists with mind files, scene, and source tags."""

    def __init__(
        self,
        agent_id: str,
        agent_name: str,
    ):
        self.agent_id = agent_id
        self.agent_name = agent_name

    def build(
        self,
        history: list[Message],
        scene_info: str = "",
        mind_context: str = "",
    ) -> list[Message]:
        """Build the message list for LLM call.

        Format:
          1. System: mind files (AGENT.md + SOUL.md + PROFILE.md)
          2. System: behavioral guidelines
          3. System: memory hint (MEMORY.md path, not content)
          4. System: scene info (if provided)
          5. Conversation history with source tags [time | scene | sender]
        """
        result: list[Message] = []

        # Layer 1: Mind files (AGENT.md + SOUL.md + PROFILE.md)
        if mind_context:
            result.append(
                Message(
                    role="system",
                    content=mind_context,
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
                    "3. 不确定如何修改时，必须调用 list_project_docs 或 search_project_docs 查找相关文档，"
                    "找到后立即调用 read_file 读取完整内容，然后按照文档指导直接执行。"
                    "查到文档列表后不要停下来，必须继续读取。\n"
                    "4. 当你不确定用户的真实意图时，优先向用户发起询问进行澄清。"
                    "询问永远比不确定的胡乱操作更为有效——宁可多问一句，也不要在误解的前提下行动。"
                ),
                meta=MessageMeta(session_id=self.agent_id),
            )
        )

        # Layer 3: Memory hint — Agent manages MEMORY.md by itself
        result.append(
            Message(
                role="system",
                content=(
                    f"【记忆提示】\n"
                    f"你的私人日记保存在 ~/.cloudmind-zome/agents/{self.agent_id}/MEMORY.md 中，"
                    "记录了与用户的互动和事件。你可以在需要回忆具体事件时主动调用 read_file 读取，"
                    "也可以在重要事件发生后主动调用 write_file 更新。"
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
        content = msg.content
        if isinstance(content, str):
            return content
        parts: list[str] = []
        for b in content:
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
