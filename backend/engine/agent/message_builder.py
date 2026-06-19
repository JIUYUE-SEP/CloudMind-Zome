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

from .workspace import MindWorkspace


class MessageBuilder:
    """Builds LLM message lists with mind files and group-chat sender prefix."""

    def __init__(
        self,
        agent_id: str,
        agent_name: str,
        codename: str = "",
        memory_path: str = "",
        enabled_skills: list[str] | None = None,
    ):
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.codename = codename
        self.memory_path = memory_path
        self.enabled_skills = enabled_skills or []

    def build(
        self,
        history: list[Message],
        scene_info: str = "",
        mind_context: str = "",
        time_tag: str = "",
    ) -> list[Message]:
        """Build the message list for LLM call.

        Format:
          1. System: mind files (AGENT.md + SOUL.md + PROFILE.md)
          2. System: behavioral guidelines
          3. System: memory hint (MEMORY.md path, not content)
          4. Conversation history (group-chat user messages prefixed with sender_name:)

        Args:
            time_tag: If provided, prepended to the last user message with a blank line.
        """
        result: list[Message] = []

        # Locate last user message for time-tag injection
        last_user_idx = -1
        for i, msg in enumerate(history):
            if msg.role == "user":
                last_user_idx = i

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

        # Layer 1.2: Skill instructions
        if self.enabled_skills:
            from ..skill.loader import build_skill_injection
            skill_block = build_skill_injection(
                self.agent_id,
                self.enabled_skills,
                per_skill_limit=3000,
                total_limit=8000,
            )
            if skill_block:
                result.append(
                    Message(
                        role="system",
                        content=skill_block,
                        meta=MessageMeta(session_id=self.agent_id),
                    )
                )

        # Layer 2: Platform capabilities declaration (injected every turn)
        result.append(
            Message(
                role="system",
                content=(
                    "【平台能力】\n"
                    "你可以使用文件工具（read_file、write_file、edit_file、list_project_docs 等）直接操作项目文件。\n"
                    "当你需要了解项目结构时，可以调用 list_project_docs 或 search_project_docs。"
                ),
                meta=MessageMeta(session_id=self.agent_id),
            )
        )

        # Layer 3: Memory hint — Agent manages MEMORY.md by itself
        memory_md_path = self.memory_path
        if not memory_md_path:
            memory_md_path = MindWorkspace(self.agent_id).path("MEMORY.md")
        result.append(
            Message(
                role="system",
                content=(
                    f"【记忆提示】\n"
                    f"你的私人日记保存在 {memory_md_path} 中，"
                    "记录了与用户的互动和事件。你可以在需要回忆具体事件时主动调用 read_file 读取，"
                    "也可以在重要事件发生后主动调用 write_file 更新。"
                ),
                meta=MessageMeta(session_id=self.agent_id),
            )
        )

        for i, msg in enumerate(history):
            if getattr(msg, "_smart_hint", False):
                result.append(msg)
                continue

            if getattr(msg.meta, "compressed", False):
                result.append(msg)
                continue

            if msg.role == "user" and msg.meta.source == "group":
                msg = self._with_sender_prefix(msg)

            # Inject time tag into the last user message after sender prefix
            if i == last_user_idx and time_tag:
                msg = self._inject_time_tag(msg, time_tag)

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

    def _inject_time_tag(self, msg: Message, time_tag: str) -> Message:
        """Prepend time tag to a user message with a blank line separator."""
        tagged = f"{time_tag}\n\n"
        if isinstance(msg.content, str):
            return Message(
                role=msg.role,
                content=tagged + msg.content,
                meta=msg.meta,
            )
        new_blocks: list[ContentBlock] = []
        injected = False
        for b in msg.content:
            if not injected and isinstance(b, TextBlock):
                new_blocks.append(TextBlock(text=tagged + b.text))
                injected = True
            else:
                new_blocks.append(b)
        if not injected:
            new_blocks.insert(0, TextBlock(text=tagged))
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
