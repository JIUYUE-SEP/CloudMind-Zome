"""ReActAgent: Core agent loop implementation.

Design reference: §6.1 Agent 核心循环, §6.1.2 ReAct 循环端到端流程,
                 Agent 全局 Worker 架构设计文档 §四、§六
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from ..message.types import (
    AgentEvent,
    ContentBlock,
    ImageBlock,
    Message,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    MessageMeta,
)
from .base import AgentBase
from .message_builder import MessageBuilder
from .stop import SmartStop
from ..provider.transport import ChatCompletionsTransport
from ..provider.thinking.base import LLMResponse
from ..tool.registry import ToolRegistry
from ..context.embedder import Embedder
from ..context.vector_store import AgentMemoryStore
from ..config.models import AppConfig
from ..session.store import SessionStore
from ..error.classifier import classify_error
from ..error.retry import get_retry_delay, RetryConfig
from ..error.fallback import FallbackChain
from ..memory.base import MemorySystem
from ..memory.registry import create_memory_system

logger = logging.getLogger(__name__)


class ReActAgent(AgentBase):
    """ReAct loop agent with unified memory (not session-isolated).

    Design reference: §6.6.2 类结构
    - One instance per Agent identity, shared across all Jobs.
    - Unified memory pool keyed by agent_id, not session_id.
    - SmartStop is global across all scenes (no reset per Job).
    - Group-chat user messages are prefixed with sender_name by MessageBuilder.
    """

    def __init__(
        self,
        name: str,
        model: ChatCompletionsTransport,
        toolkit: ToolRegistry,
        context_manager: Any = None,  # DEPRECATED: kept for backward compat
        memory_system: MemorySystem | None = None,
        session_store: SessionStore | None = None,
        agent_id: str = "",
        config: AppConfig | None = None,
        fallback_transports: dict[str, ChatCompletionsTransport] | None = None,
        personality_prompt: str = "",
        embedder: Embedder | None = None,
        memory_store: AgentMemoryStore | None = None,
        model_config: dict | None = None,
    ):
        super().__init__(name=name, session_id="", config=config)

        self.agent_id = agent_id or name
        self.model = model
        self.toolkit = toolkit
        self.session_store = session_store
        self.embedder = embedder
        self.memory_store = memory_store
        self.model_config = model_config or {}

        # Create memory system if not provided
        if memory_system is None:
            mem_cfg = "simple"
            if config and config.agent:
                mem_cfg = getattr(config.agent, "memory_system", "simple") or "simple"
            try:
                memory_system = create_memory_system(mem_cfg, agent=self, config=config)
            except Exception as e:
                logger.warning("Failed to create memory system '%s', falling back to simple: %s", mem_cfg, e)
                memory_system = create_memory_system("simple", agent=self, config=config)
        self.memory_system = memory_system

        # Error recovery
        self._fallback = FallbackChain(
            config.provider.fallback_chain if config and config.provider else []
        )
        self._transports = fallback_transports or {}
        self._current_transport = model
        self._retry_config = RetryConfig()

        # Smart stop configuration — global, never reset
        smart_stop_config = config.agent.smart_stop if config else None
        self.smart_stop = SmartStop(
            max_turns=smart_stop_config.max_turns if smart_stop_config else 50,
            max_tokens=smart_stop_config.max_tokens if smart_stop_config else 200000,
            timeout_seconds=smart_stop_config.timeout_seconds if smart_stop_config else 600,
            no_progress_rounds=smart_stop_config.no_progress_rounds if smart_stop_config else 3,
            loop_detect_rounds=smart_stop_config.loop_detect_rounds if smart_stop_config else 2,
        )

        # Conversation history in memory (scene-isolated by source_id)
        self._messages: list[Message] = []
        self._current_source_id: str = ""

        self._msg_builder = MessageBuilder(
            agent_id=self.agent_id,
            agent_name=self.name,
        )

    # ------------------------------------------------------------------
    # Ingest (no reply)
    # ------------------------------------------------------------------

    async def ingest_message(
        self,
        user_message: str,
        scene_info: str = "",
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_name: str = "",
        content_type: str = "text",
    ) -> None:
        """Receive a message into memory WITHOUT generating a reply.

        Used in group chat: ALL agents get the message via AgentWorker FIFO queue,
        then each Agent's LLM decides whether to reply or stay_silent.

        Does NOT trigger:
        - SmartStop
        - Tool execution
        - LLM inference

        Does trigger:
        - MemorySystem.on_user_message()
        - _save_message() (persist to DB + vector store)
        """
        # Scene isolation: switch _messages when source_id changes
        if source_id != self._current_source_id:
            self._messages.clear()
            self._current_source_id = source_id
            logger.info("Agent %s ingest switched to source_id %s", self.agent_id, source_id)
        else:
            self._messages = [
                m for m in self._messages
                if not getattr(m, '_smart_hint', False)
            ]

        # Load history for current source_id if empty
        if not self._messages:
            await self._load_history(source_id=source_id)

        # Add user message to history
        if content_type == "image":
            image_source = await self._resolve_image_source(user_message)
            user_content = [ImageBlock(source=image_source)]
        elif content_type == "mixed":
            user_content = await self._parse_mixed_content(user_message)
        else:
            user_content = user_message

        user_msg = Message(
            role="user",
            content=user_content,
            meta=MessageMeta(
                session_id=source_id,
                round=len(self._messages) // 2,
                source=source,
                source_name=source_name,
                sender_name=sender_name,
            ),
        )
        self._messages.append(user_msg)
        await self._save_message(user_msg, source, source_id, source_name, sender_name)

        # Initialize memory system on first use
        if not getattr(self, '_memory_initialized', False):
            try:
                await self.memory_system.initialize()
            except Exception as e:
                logger.warning("Memory system initialize failed: %s", e)
            self._memory_initialized = True

        # Notify memory system of user message
        try:
            await self.memory_system.on_user_message(user_msg)
        except Exception as e:
            logger.warning("Memory system on_user_message failed: %s", e)

        # Compression check (lightweight)
        try:
            await self.memory_system.check_compression()
        except Exception as e:
            logger.warning("Memory system check_compression failed: %s", e)

    async def stream(
        self,
        user_message: str,
        scene_info: str = "",
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_name: str = "",
        content_type: str = "text",
        is_mentioned: bool = False,
    ) -> AsyncIterator[AgentEvent]:
        """Stream-based conversation entry point.

        Args:
            user_message: User's input message.
            scene_info: Deprecated, kept for backward compat.
            source: "private" | "group" | "workflow".
            source_id: Session/group/workflow ID.
            sender_name: Display name of the sender.
            is_mentioned: Whether this agent was @mentioned in group chat.

        Yields:
            AgentEvent: thinking / content / tool_call / tool_result / done
        """
        # Reset per-Job state
        self.smart_stop.reset()
        self._fallback.reset()
        self._current_transport = self.model

        # Scene isolation: switch _messages when source_id changes
        if source_id != self._current_source_id:
            self._messages.clear()
            self._current_source_id = source_id
            logger.info("Agent %s switched to source_id %s, cleared in-memory messages", self.agent_id, source_id)
        else:
            # Purge SmartStop hints from previous Jobs (they are transient)
            self._messages = [
                m for m in self._messages
                if not getattr(m, '_smart_hint', False)
            ]

        # Load history for current source_id if empty
        if not self._messages:
            await self._load_history(source_id=source_id)

        # Trim in-memory history to prevent unbounded growth
        max_mem_msgs = 500
        if self.config and self.config.agent:
            max_mem_msgs = getattr(self.config.agent, "max_memory_messages", 500) or 500
        if len(self._messages) > max_mem_msgs:
            trim_count = len(self._messages) - max_mem_msgs
            self._messages = self._messages[trim_count:]
            logger.info("Trimmed %d old messages from memory", trim_count)

        # Add user message to history
        if content_type == "image":
            image_source = await self._resolve_image_source(user_message)
            user_content = [ImageBlock(source=image_source)]
        elif content_type == "mixed":
            user_content = await self._parse_mixed_content(user_message)
        else:
            user_content = user_message
        user_msg = Message(
            role="user",
            content=user_content,
            meta=MessageMeta(
                session_id=source_id,
                round=len(self._messages) // 2,
                source=source,
                source_name=source_name,
                sender_name=sender_name,
            ),
        )
        self._messages.append(user_msg)
        await self._save_message(user_msg, source, source_id, source_name, sender_name)

        # Initialize memory system on first use
        if not getattr(self, '_memory_initialized', False):
            try:
                await self.memory_system.initialize()
            except Exception as e:
                logger.warning("Memory system initialize failed: %s", e)
            self._memory_initialized = True

        # Notify memory system of user message
        try:
            await self.memory_system.on_user_message(user_msg)
        except Exception as e:
            logger.warning("Memory system on_user_message failed: %s", e)

        # Compression check
        try:
            await self.memory_system.check_compression()
        except Exception as e:
            logger.warning("Memory system check_compression failed: %s", e)

        # ReAct loop
        while True:
            self.smart_stop.increment_turn()

            # Step 1: Build messages via Context Pipeline (retrieval + downgrade)
            mind_context = self._load_mind_files()

            # Build personality description for group chat
            personality_desc = ""
            if source != "private" and self.model_config:
                personality = (self.model_config.get("personality") or {})
                if personality:
                    from ..personality.prompt_builder import personality_to_prompt
                    personality_desc = personality_to_prompt(personality)
                    if is_mentioned:
                        personality_desc += "\n\n【注意】有人在群聊中 @了你（提到了你的名字），请认真考虑是否要回复。"

            # Lazy-init pipeline
            if not hasattr(self, "_context_pipeline"):
                from ..context.context_pipeline import ContextPipeline
                self._context_pipeline = ContextPipeline(
                    agent_id=self.agent_id,
                    msg_builder=self._msg_builder,
                    embedder=self.embedder,
                    memory_store=self.memory_store,
                    memory_system=self.memory_system,
                    config=self.config.context if self.config else None,
                )

            try:
                messages = await self._context_pipeline.assemble(
                    history=self._messages,
                    scene_info=scene_info,
                    mind_context=mind_context,
                    tools=await self._get_tools(),
                    source_id=source_id,
                    source_name=source_name,
                    personality_desc=personality_desc,
                )
            except Exception as e:
                logger.warning("ContextPipeline failed, falling back to legacy build: %s", e)
                messages = self._msg_builder.build(self._messages, scene_info, mind_context)
                try:
                    messages = await self.memory_system.before_llm(messages)
                except Exception as e2:
                    logger.warning("Memory system before_llm failed: %s", e2)

            # Step 3: Call LLM via true streaming (retry/fallback inline)
            content_parts: list[str] = []
            reasoning_parts: list[str] = []
            tool_calls: list[dict] = []

            try:
                async for block in self._call_llm_stream_with_recovery(
                    messages=messages, tools=await self._get_tools()
                ):
                    if isinstance(block, ThinkingBlock):
                        reasoning_parts.append(block.thinking)
                        yield AgentEvent(type="thinking", data=block)
                    elif isinstance(block, TextBlock):
                        content_parts.append(block.text)
                        yield AgentEvent(type="content", data=block)
                    elif isinstance(block, ToolUseBlock):
                        tool_calls.append({
                            "id": block.id,
                            "name": block.name,
                            "arguments": block.input,
                        })
                        yield AgentEvent(type="tool_call", data=block)
            except Exception as e:
                logger.error("LLM stream failed after all retries and fallbacks: %s", e)
                yield AgentEvent(type="error", data=TextBlock(text=str(e)))
                yield AgentEvent(type="done")
                return

            # Assemble response from collected parts
            response = LLMResponse(
                content="".join(content_parts) or None,
                reasoning_content="".join(reasoning_parts) or None,
                tool_calls=tool_calls,
                finish_reason="",
                usage={},
            )

            # Notify memory system of assistant response
            try:
                await self.memory_system.on_assistant_response(response)
            except Exception as e:
                logger.warning("Memory system on_assistant_response failed: %s", e)

            # Track tokens (streaming path has no usage; estimate)
            text_len = len((response.content or "").encode("utf-8"))
            thinking_len = len((response.reasoning_content or "").encode("utf-8"))
            self.smart_stop.add_tokens(max(1, (text_len + thinking_len) // 3))

            stop_decision = self.smart_stop.check(self._messages)

            if stop_decision.stop:
                if stop_decision.reason:
                    logger.info("Smart stop triggered: %s", stop_decision.reason)
                yield AgentEvent(type="done")
                return

            if stop_decision.inject_hint:
                hint_msg = Message(
                    role="system",
                    content=stop_decision.inject_hint,
                    meta=MessageMeta(session_id=source_id, compressed=False),
                )
                hint_msg._smart_hint = True  # type: ignore[attr-defined]
                self._messages.append(hint_msg)

            # Check for tool calls
            if not response.tool_calls:
                content_text = response.content or ""
                if not content_text:
                    for msg in reversed(self._messages):
                        if msg.role == "tool":
                            url = MessageBuilder.extract_shared_url(msg)
                            if url:
                                content_text = url
                                break

                assistant_msg = Message(
                    role="assistant",
                    content=content_text,
                    meta=MessageMeta(
                        session_id=source_id,
                        round=len(self._messages) // 2,
                        source=source,
                        source_name=source_name,
                        sender_name=self.name,
                    ),
                )
                if response.reasoning_content:
                    assistant_msg.content = [
                        ThinkingBlock(thinking=response.reasoning_content),
                        TextBlock(text=content_text),
                    ]
                self._messages.append(assistant_msg)
                await self._save_message(assistant_msg, source, source_id, source_name, self.name)
                yield AgentEvent(type="done")
                return

            # Build assistant message with tool calls
            content: list[ContentBlock] = []
            if response.reasoning_content:
                content.append(ThinkingBlock(thinking=response.reasoning_content))
            if response.content:
                content.append(TextBlock(text=response.content))

            for tc in response.tool_calls:
                content.append(
                    ToolUseBlock(id=tc["id"], name=tc["name"], input=tc["arguments"])
                )
                yield AgentEvent(
                    type="tool_call",
                    data=ToolUseBlock(id=tc["id"], name=tc["name"], input=tc["arguments"]),
                )

            assistant_msg = Message(
                role="assistant",
                content=content if content else "",
                meta=MessageMeta(
                    session_id=source_id,
                    round=len(self._messages) // 2,
                    source=source,
                    source_name=source_name,
                    sender_name=self.name,
                ),
            )
            self._messages.append(assistant_msg)
            await self._save_message(assistant_msg, source, source_id, source_name, self.name)

            # Validate tool calls before execution (pre-filter hallucinations)
            available_tools = self.toolkit.list_tools()
            valid_tool_calls: list[dict] = []
            for tc in response.tool_calls:
                tool_name = tc.get("name", "")
                if tool_name not in available_tools:
                    err_content = (
                        f"Tool '{tool_name}' not found. "
                        f"Available tools: {', '.join(available_tools)}"
                    )
                    tool_result = ToolResultBlock(
                        id=tc.get("id", ""),
                        content=err_content,
                        truncated=False,
                    )
                    yield AgentEvent(type="tool_result", data=tool_result)
                    result_msg = Message(
                        role="tool",
                        content=[tool_result],
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                            sender_name="系统",
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, "系统")
                    logger.warning(
                        "Agent %s hallucinated tool '%s'; available: %s",
                        self.agent_id,
                        tool_name,
                        available_tools,
                    )
                else:
                    valid_tool_calls.append(tc)

            if not valid_tool_calls:
                yield AgentEvent(type="done")
                return

            # Execute tools
            parallel = all(
                self.toolkit.get_tool(tc["name"]).get("safe_to_parallel", True)
                for tc in valid_tool_calls
            )

            # Detect stay_silent and exit early if called
            def _is_stay_silent(tool_name: str, tool_result: ToolResultBlock) -> bool:
                return tool_name == "stay_silent" or "[stay_silent]" in str(tool_result.content)

            if parallel and len(valid_tool_calls) > 1:
                tasks = [self._execute_tool(tc) for tc in valid_tool_calls]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for tc, result in zip(valid_tool_calls, results):
                    tool_name = tc.get("name", "")
                    if isinstance(result, Exception):
                        tool_result = ToolResultBlock(
                            id=tc["id"],
                            content=f"Error: {type(result).__name__}: {result}",
                            truncated=False,
                        )
                    else:
                        tool_result = result

                    # stay_silent: end turn without output
                    if _is_stay_silent(tool_name, tool_result):
                        logger.info("Agent %s stay_silent in %s, ending turn", self.agent_id, source)
                        yield AgentEvent(type="done")
                        return

                    yield AgentEvent(type="tool_result", data=tool_result)

                    result_msg = Message(
                        role="tool",
                        content=[tool_result],
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                            sender_name="系统",
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, "系统")
                    try:
                        await self.memory_system.on_tool_result(tool_result)
                    except Exception as e:
                        logger.warning("Memory system on_tool_result failed: %s", e)
            else:
                for tc in valid_tool_calls:
                    tool_name = tc.get("name", "")
                    tool_result = await self._execute_tool(tc)

                    # stay_silent: end turn without output
                    if _is_stay_silent(tool_name, tool_result):
                        logger.info("Agent %s stay_silent in %s, ending turn", self.agent_id, source)
                        yield AgentEvent(type="done")
                        return

                    yield AgentEvent(type="tool_result", data=tool_result)

                    result_msg = Message(
                        role="tool",
                        content=[tool_result],
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                            sender_name="系统",
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, "系统")
                    try:
                        await self.memory_system.on_tool_result(tool_result)
                    except Exception as e:
                        logger.warning("Memory system on_tool_result failed: %s", e)

            # Continue loop

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _call_llm_stream_with_recovery(
        self,
        messages: list[Message],
        tools: list[dict],
    ) -> AsyncIterator[ContentBlock]:
        """Stream LLM response with retry and provider fallback.

        Yields ContentBlock as they arrive from the API.
        On retry/fallback, re-opens the stream from the new provider.
        """
        attempt = 0
        last_error: Exception | None = None

        while True:
            try:
                async for block in self._current_transport.stream(messages, tools):
                    yield block
                return
            except Exception as e:
                last_error = e
                current_provider = self._fallback.current_provider
                classified = classify_error(e, provider=current_provider)

                if classified.retryable:
                    delay = get_retry_delay(
                        classified.reason.value, attempt, self._retry_config
                    )
                    if delay >= 0:
                        logger.warning(
                            "LLM stream failed on %s (attempt %d, %s), "
                            "retrying in %.1fs: %s",
                            current_provider,
                            attempt,
                            classified.reason.value,
                            delay,
                            e,
                        )
                        await asyncio.sleep(delay)
                        attempt += 1
                        continue

                if self._fallback.should_fallback(classified):
                    old_provider = current_provider
                    next_provider = self._fallback.fallback()
                    if next_provider and next_provider in self._transports:
                        logger.warning(
                            "Falling back from %s to %s (%s)",
                            old_provider,
                            next_provider,
                            classified.reason.value,
                        )
                        self._current_transport = self._transports[next_provider]
                        attempt = 0
                        continue

                raise last_error

    async def _execute_tool(self, tool_call: dict) -> ToolResultBlock:
        """Execute a single tool call with error handling."""
        tool_name = tool_call["name"]
        arguments = tool_call.get("arguments", {})
        tool_use_id = tool_call["id"]

        tool_use = ToolUseBlock(id=tool_use_id, name=tool_name, input=arguments)
        modified = await self.on_before_tool(tool_use)
        if modified is None:
            return ToolResultBlock(
                id=tool_use_id,
                content="Tool call cancelled",
                truncated=False,
            )

        from ..tools.comms.context import set_current_agent_id
        set_current_agent_id(self.agent_id)
        try:
            result = await self.toolkit.execute(tool_name, arguments)
            max_chars = self.toolkit.get_tool(tool_name).get("max_result_chars", 12000)
            content = self._truncate_result(result, max_chars, tool_name)

            tool_result = ToolResultBlock(
                id=tool_use_id,
                content=content,
                truncated=len(str(result)) > max_chars,
                metadata=result if not isinstance(result, str) else None,
            )
        except Exception as e:
            tool_result = ToolResultBlock(
                id=tool_use_id,
                content=f"Error: {type(e).__name__}: {e}",
                truncated=False,
            )
        finally:
            set_current_agent_id("")

        tool_result = await self.on_after_tool(tool_result)
        return tool_result

    async def on_before_llm(self, messages: list[Message]) -> list[Message]:
        """DEPRECATED: Replaced by MemorySystem.before_llm().

        Kept for backward compatibility with external callers.
        """
        return messages

    async def _get_tools(self) -> list[dict]:
        """Get tool schemas for the LLM request."""
        return self.toolkit.get_schemas()

    async def _parse_mixed_content(self, text: str) -> list[ContentBlock]:
        """Parse mixed content like '[image:/uploads/...]\\nHello' into blocks."""
        import re
        blocks: list[ContentBlock] = []
        pattern = re.compile(r'\[image:([^\]]+)\]')
        last_end = 0
        for m in pattern.finditer(text):
            if m.start() > last_end:
                segment = text[last_end:m.start()].strip()
                if segment:
                    blocks.append(TextBlock(text=segment))
            img_url = m.group(1).strip()
            if img_url:
                image_source = await self._resolve_image_source(img_url)
                blocks.append(ImageBlock(source=image_source))
            last_end = m.end()
        if last_end < len(text):
            segment = text[last_end:].strip()
            if segment:
                blocks.append(TextBlock(text=segment))
        if not blocks:
            blocks.append(TextBlock(text=text))
        return blocks

    async def _resolve_image_source(self, url: str) -> dict[str, Any]:
        """Convert image URL to format suitable for LLM vision API.

        If URL is a local path, read the file and encode as base64 data URL.
        Otherwise pass through as-is (for externally accessible URLs).
        """
        import base64
        from pathlib import Path

        # If already a data URL or absolute HTTP URL, pass through
        if url.startswith("data:") or url.startswith("http://") or url.startswith("https://"):
            return {"url": url}

        # Resolve local file path
        # URL format: /uploads/{folder}/{filename}
        if url.startswith("/uploads/"):
            relative_path = url[len("/uploads/"):]
            upload_dir = Path.home() / ".cloudmind-zome" / "uploads"
            file_path = upload_dir / relative_path
        else:
            # Try as absolute path
            file_path = Path(url)

        if file_path.exists():
            data = file_path.read_bytes()
            b64 = base64.b64encode(data).decode("utf-8")
            # Detect MIME type from extension
            ext = file_path.suffix.lower()
            mime_map = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".bmp": "image/bmp",
                ".svg": "image/svg+xml",
            }
            mime = mime_map.get(ext, "image/png")
            return {"url": f"data:{mime};base64,{b64}"}

        # Fallback: pass original URL and hope the provider can access it
        return {"url": url}

    def _truncate_result(self, result: Any, max_chars: int, tool_name: str) -> str:
        """Truncate tool result if necessary."""
        content = str(result)
        if len(content) <= max_chars:
            return content
        truncated = content[:max_chars]
        truncated += (
            f"\n\n[Result truncated. Total {len(content)} characters. "
            "Only the first part is shown to save context space.]"
        )
        return truncated

    def _load_mind_files(self) -> str:
        """Read mind files every turn so edits on disk are reflected immediately.

        Sources (in priority order):
          1. userdata/profile.md  — user self-defined profile (read-only to agent)
          2. agents/{id}/USER.md  — agent's perception of the user
          3. agents/{id}/SOUL.md  — soul core / personality
          4. agents/{id}/AGENT.md — working rules / guidelines
        """
        from pathlib import Path
        import re

        userdata_dir = Path.home() / ".cloudmind-zome" / "userdata"
        agent_dir = Path.home() / ".cloudmind-zome" / "agents" / self.agent_id
        parts: list[str] = []

        def _strip_frontmatter(text: str) -> str:
            text = text.strip()
            if text.startswith("---"):
                split = text.split("---", 2)
                if len(split) >= 3:
                    text = split[2].strip()
            return text

        # 1. userdata/profile.md — user self-defined profile
        user_profile_path = userdata_dir / "profile.md"
        if user_profile_path.exists():
            try:
                text = _strip_frontmatter(user_profile_path.read_text(encoding="utf-8"))
                if text:
                    parts.append(f"【用户档案】\n{text}")
            except Exception as exc:
                logger.warning("Failed to read userdata/profile.md: %s", exc)

        # 2. USER.md — agent's perception of the user
        user_path = agent_dir / "USER.md"
        if user_path.exists():
            try:
                text = _strip_frontmatter(user_path.read_text(encoding="utf-8"))
                if text:
                    parts.append(f"【心智眼中的用户】\n{text}")
            except Exception as exc:
                logger.warning("Failed to read USER.md for %s: %s", self.agent_id, exc)

        # 3. SOUL.md — soul core
        soul_path = agent_dir / "SOUL.md"
        if soul_path.exists():
            try:
                text = _strip_frontmatter(soul_path.read_text(encoding="utf-8"))
                if text:
                    parts.append(f"【灵魂内核】\n{text}")
            except Exception as exc:
                logger.warning("Failed to read SOUL.md for %s: %s", self.agent_id, exc)

        # 4. AGENT.md — working rules / guidelines
        agent_path = agent_dir / "AGENT.md"
        if agent_path.exists():
            try:
                text = _strip_frontmatter(agent_path.read_text(encoding="utf-8"))
                # Remove heartbeat / memory marker sections (same as QwenPaw)
                text = re.sub(
                    r"<!--\s*(heartbeat|memory):start\s*-->.*?<!--\s*\1:end\s*-->",
                    "",
                    text,
                    flags=re.DOTALL,
                )
                text = text.strip()
                if text:
                    parts.append(f"【工作规范】\n{text}")
            except Exception as exc:
                logger.warning("Failed to read AGENT.md for %s: %s", self.agent_id, exc)

        if not parts:
            logger.info("No mind files found for agent %s at %s", self.agent_id, agent_dir)

        return "\n\n".join(parts)

    async def _load_history(self, source_id: str = "") -> None:
        """Load scene-isolated history from agent_messages table.

        Filters out ALL system messages — personality and scene prompts are
        re-injected dynamically in _build_messages every turn, so they should
        never be part of the conversation history.
        """
        if not self.session_store or not self.agent_id:
            return
        try:
            raw = await self.session_store.load_agent_messages(
                self.agent_id, source_id=source_id, limit=1000
            )
            # Drop system messages EXCEPT compressed topic summaries
            self._messages = [
                m for m in raw
                if m.role != "system" or getattr(m.meta, "compressed", False)
            ]
            if len(self._messages) < len(raw):
                logger.info(
                    "Filtered %d system messages from loaded history",
                    len(raw) - len(self._messages),
                )
            logger.info(
                "Loaded %d messages for agent %s (source_id=%s)",
                len(self._messages),
                self.agent_id,
                source_id or "(all)",
            )
        except Exception as e:
            logger.warning("Failed to load history for agent %s: %s", self.agent_id, e)

    async def _save_message(
        self,
        message: Message,
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_name: str = "",
    ) -> None:
        """Save a message to the unified agent memory pool + vector store."""
        if not self.session_store or not self.agent_id:
            return
        try:
            await self.session_store.save_agent_message(
                message,
                agent_id=self.agent_id,
                source=source,
                source_id=source_id,
                source_name=source_name,
                sender_name=sender_name,
            )
        except Exception as e:
            logger.warning("Failed to save message: %s", e)

        # Semantic indexing (fire-and-forget)
        # Use _extract_text_only to exclude ThinkingBlock from embedding
        if self.embedder and self.memory_store and message.meta.id:
            text = MessageBuilder.extract_text_only(message)
            if text and len(text) > 5:
                try:
                    vec = await self.embedder.embed_single(text)
                    if vec:
                        import time
                        self.memory_store.add(
                            agent_id=self.agent_id,
                            message_id=message.meta.id,
                            text=text[:2000],
                            embedding=vec,
                            metadata={
                                "role": message.role,
                                "source": source,
                                "source_name": source_name,
                                "source_id": source_id,
                            },
                            timestamp=time.time(),
                        )
                except Exception as e:
                    logger.warning("Failed to index message vector: %s", e)
