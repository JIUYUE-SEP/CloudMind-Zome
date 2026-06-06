"""Message builder: source tagging, scene injection, history formatting.

Extracted from ReActAgent to reduce class complexity.
"""

from __future__ import annotations

import re

from ..message.types import (
    ContentBlock,
    Message,
    MessageMeta,
    TextBlock,
    ToolResultBlock,
)


class MessageBuilder:
    """Builds LLM message lists with mind files and group-chat sender prefix."""

    def __init__(
        self,
        agent_id: str,
        agent_name: str,
        codename: str = "",
    ):
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.codename = codename

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
          4. Conversation history (group-chat user messages prefixed with sender_name:)
        """
        result: list[Message] = []

        # Layer 0: Identity fallback — always injected so the LLM knows who it is
        identity_line = f"你是 {self.agent_name}"
        if self.codename and self.codename != self.agent_name:
            identity_line += f"（{self.codename}）"
        result.append(
            Message(
                role="system",
                content=identity_line + "。",
                meta=MessageMeta(session_id=self.agent_id),
            )
        )

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
                    "1. 当用户要求添加、修改或删除系统功能时，你拥有直接执行的能力。"
                    "先查看相关代码作为参考，然后直接调用工具修改。每完成一步向用户汇报。"
                    "不要把技术文档发给用户让用户自己操作。\n"
                    "2. 不确定如何修改时，必须调用 list_project_docs 或 search_project_docs 查找相关文档，"
                    "找到后立即调用 read_file 读取完整内容，然后按照文档指导直接执行。"
                    "查到文档列表后不要停下来，必须继续读取。\n"
                    "3. 当你不确定用户的真实意图时，优先向用户发起询问进行澄清。"
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

        for msg in history:
            if getattr(msg, "_smart_hint", False):
                result.append(msg)
                continue

            if getattr(msg.meta, "compressed", False):
                result.append(msg)
                continue

            if msg.role == "user" and msg.meta.source == "group":
                result.append(self._with_sender_prefix(msg))
            else:
                result.append(msg)

        return result

    def _with_sender_prefix(self, msg: Message) -> Message:
        """Prefix a group-chat user message with sender_name:."""
        prefix = f"{msg.meta.sender_name or '用户'}: "
        if isinstance(msg.content, str):
            return Message(
                role=msg.role,
                content=prefix + msg.content,
                meta=msg.meta,
            )
        new_blocks: list[ContentBlock] = []
        prefixed = False
        for b in msg.content:
            if not prefixed and isinstance(b, TextBlock):
                new_blocks.append(TextBlock(text=prefix + b.text))
                prefixed = True
            else:
                new_blocks.append(b)
        if not prefixed:
            new_blocks.insert(0, TextBlock(text=prefix))
        return Message(role=msg.role, content=new_blocks, meta=msg.meta)

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
