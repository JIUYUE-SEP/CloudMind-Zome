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
    Message,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    MessageMeta,
)
from .base import AgentBase
from .stop import SmartStop
from ..provider.transport import ChatCompletionsTransport
from ..tool.registry import ToolRegistry
from ..context.manager import ContextManager
from ..context.embedder import Embedder
from ..context.vector_store import AgentMemoryStore
from ..config.models import AppConfig
from ..session.store import SessionStore
from ..error.classifier import classify_error
from ..error.retry import get_retry_delay, RetryConfig
from ..error.fallback import FallbackChain

logger = logging.getLogger(__name__)


class ReActAgent(AgentBase):
    """ReAct loop agent with unified memory (not session-isolated).

    Design reference: §6.6.2 类结构
    - One instance per Agent identity, shared across all Jobs.
    - Unified memory pool keyed by agent_id, not session_id.
    - SmartStop is global across all scenes (no reset per Job).
    - Scene info is injected into system prompt every turn.
    """

    def __init__(
        self,
        name: str,
        model: ChatCompletionsTransport,
        toolkit: ToolRegistry,
        context_manager: ContextManager,
        session_store: SessionStore | None = None,
        agent_id: str = "",
        config: AppConfig | None = None,
        fallback_transports: dict[str, ChatCompletionsTransport] | None = None,
        personality_prompt: str = "",
        embedder: Embedder | None = None,
        memory_store: AgentMemoryStore | None = None,
    ):
        super().__init__(name=name, session_id="", config=config)

        self.agent_id = agent_id or name
        self.model = model
        self.toolkit = toolkit
        self.context_manager = context_manager
        self.session_store = session_store
        self.embedder = embedder
        self.memory_store = memory_store

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

        # Conversation history in memory (accumulated across all Jobs)
        self._messages: list[Message] = []

        # Personality prompt (loaded once, reused every turn)
        self._personality_prompt: str | None = None
        if personality_prompt:
            self._personality_prompt = personality_prompt
        elif config and config.agent.identity:
            try:
                from pathlib import Path
                identity_path = Path(config.agent.identity)
                if identity_path.exists():
                    self._personality_prompt = identity_path.read_text(encoding="utf-8")
            except Exception as e:
                logger.warning("Failed to load identity prompt: %s", e)

    async def stream(
        self,
        user_message: str,
        scene_info: str = "",
        source: str = "private",
        source_id: str = "",
        source_name: str = "",
        sender_name: str = "",
    ) -> AsyncIterator[AgentEvent]:
        """Stream-based conversation entry point.

        Args:
            user_message: User's input message.
            scene_info: Scene injection string (e.g. "当前场景：私聊").
            source: "private" | "group" | "workflow".
            source_id: Session/group/workflow ID.
            sender_name: Display name of the sender.

        Yields:
            AgentEvent: thinking / content / tool_call / tool_result / done
        """
        # Reset per-Job state
        self.smart_stop.reset()
        self._fallback.reset()
        self._current_transport = self.model

        # Load unified history on first use (filters out personality)
        if not self._messages:
            await self._load_history()

        # Trim in-memory history to prevent unbounded growth
        max_mem_msgs = getattr(self.config, "agent", None) and getattr(
            self.config.agent, "max_memory_messages", 500
        ) or 500
        if len(self._messages) > max_mem_msgs:
            trim_count = len(self._messages) - max_mem_msgs
            self._messages = self._messages[trim_count:]
            logger.info("Trimmed %d old messages from memory", trim_count)

        # Add user message to history
        user_msg = Message(
            role="user",
            content=user_message,
            meta=MessageMeta(
                session_id=source_id,
                round=len(self._messages) // 2,
                source=source,
                source_name=source_name,
            ),
        )
        self._messages.append(user_msg)
        await self._save_message(user_msg, source, source_id, source_name, sender_name)

        # Step 0: Compress pure history (without personality/scene)
        # before building the full message list
        self._messages = await self.context_manager.compress_if_needed(
            self._messages, self.agent_id
        )

        # ReAct loop
        while True:
            self.smart_stop.increment_turn()

            # Step 1: Build messages with personality + scene + history
            messages = self._build_messages(scene_info)
            messages = await self.on_before_llm(messages)

            # Step 3: Call LLM with retry + fallback
            try:
                response = await self._call_llm_with_recovery(
                    messages=messages, tools=await self._get_tools()
                )
            except Exception as e:
                logger.error("LLM call failed after all retries and fallbacks: %s", e)
                yield AgentEvent(type="done")
                return

            # Step 4: Process response
            if response.reasoning_content:
                yield AgentEvent(
                    type="thinking",
                    data=ThinkingBlock(thinking=response.reasoning_content),
                )

            if response.content:
                yield AgentEvent(type="content", data=TextBlock(text=response.content))

            # Track tokens
            if response.usage:
                self.smart_stop.add_tokens(response.usage.get("total_tokens", 0))

            stop_decision = self.smart_stop.check(self._messages)

            if stop_decision.stop:
                if stop_decision.reason:
                    logger.info("Smart stop triggered: %s", stop_decision.reason)
                yield AgentEvent(type="done")
                return

            if stop_decision.inject_hint:
                # SmartStop hint is injected into _messages for the current Job's
                # LLM context, but NOT saved to long-term memory (agent_messages).
                # These are internal intervention messages, not conversation history.
                hint_msg = Message(
                    role="system",
                    content=stop_decision.inject_hint,
                    meta=MessageMeta(session_id=source_id),
                )
                self._messages.append(hint_msg)

            # Check for tool calls
            if not response.tool_calls:
                assistant_msg = Message(
                    role="assistant",
                    content=response.content or "",
                    meta=MessageMeta(
                        session_id=source_id,
                        round=len(self._messages) // 2,
                        source=source,
                        source_name=source_name,
                    ),
                )
                if response.reasoning_content:
                    assistant_msg.content = [
                        ThinkingBlock(thinking=response.reasoning_content),
                        TextBlock(text=response.content or ""),
                    ]
                self._messages.append(assistant_msg)
                await self._save_message(assistant_msg, source, source_id, source_name, sender_name)
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
                ),
            )
            self._messages.append(assistant_msg)
            await self._save_message(assistant_msg, source, source_id, source_name, sender_name)

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
                        content=tool_result,
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, sender_name)
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

            if parallel and len(valid_tool_calls) > 1:
                tasks = [self._execute_tool(tc) for tc in valid_tool_calls]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for tc, result in zip(valid_tool_calls, results):
                    if isinstance(result, Exception):
                        tool_result = ToolResultBlock(
                            id=tc["id"],
                            content=f"Error: {type(result).__name__}: {result}",
                            truncated=False,
                        )
                    else:
                        tool_result = result

                    yield AgentEvent(type="tool_result", data=tool_result)

                    result_msg = Message(
                        role="tool",
                        content=tool_result,
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, sender_name)
            else:
                for tc in valid_tool_calls:
                    tool_result = await self._execute_tool(tc)
                    yield AgentEvent(type="tool_result", data=tool_result)

                    result_msg = Message(
                        role="tool",
                        content=tool_result,
                        meta=MessageMeta(
                            session_id=source_id,
                            round=len(self._messages) // 2,
                            source=source,
                            source_name=source_name,
                        ),
                    )
                    self._messages.append(result_msg)
                    await self._save_message(result_msg, source, source_id, source_name, sender_name)

            # Continue loop

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_messages(self, scene_info: str) -> list[Message]:
        """Build the message list for LLM call.

        Format:
          1. System: personality prompt (once per call)
          2. System: scene info (if provided) — injected every turn
          3. Existing conversation history (raw content, no source tags)
        """
        result: list[Message] = []

        # Personality prompt (not in _messages, injected dynamically)
        if self._personality_prompt:
            result.append(
                Message(
                    role="system",
                    content=self._personality_prompt,
                    meta=MessageMeta(session_id=self.agent_id),
                )
            )

        # Scene injection (every turn, because scene changes per-Job)
        if scene_info:
            result.append(
                Message(
                    role="system",
                    content=f"────\n{scene_info}\n────",
                    meta=MessageMeta(session_id=self.agent_id),
                )
            )

        # Conversation history — use raw content without source tags.
        # Source metadata is stored in message.meta for compression/search,
        # but injecting tags into content pollutes the LLM context and
        # causes the agent to mimic the tag format in its replies.
        result.extend(self._messages)
        return result

    async def _call_llm_with_recovery(
        self,
        messages: list[Message],
        tools: list[dict],
    ) -> Any:
        """Call LLM with retry and provider fallback.

        Design reference: §6.9 错误恢复
        """
        attempt = 0
        last_error: Exception | None = None

        while True:
            try:
                return await self._current_transport.chat(
                    messages=messages, tools=tools
                )
            except Exception as e:
                last_error = e
                current_provider = self._fallback.current_provider
                classified = classify_error(e, provider=current_provider)

                # Retry if retryable
                if classified.retryable:
                    delay = get_retry_delay(
                        classified.reason.value, attempt, self._retry_config
                    )
                    if delay >= 0:
                        logger.warning(
                            "LLM call failed on %s (attempt %d, %s), "
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

                # No more retries, try fallback
                if self._fallback.should_fallback(classified):
                    old_provider = current_provider
                    next_provider = self._fallback.fallback()
                    if (
                        next_provider
                        and next_provider in self._transports
                    ):
                        logger.warning(
                            "Falling back from %s to %s (%s)",
                            old_provider,
                            next_provider,
                            classified.reason.value,
                        )
                        self._current_transport = self._transports[next_provider]
                        attempt = 0  # Reset retry counter for new provider
                        continue

                # Exhausted all options
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
        """Inject semantic/hot/warm/cold memory before LLM call."""
        return await self.context_manager.augment(
            messages,
            session_id=self.agent_id,
            layers=["semantic", "hot", "warm", "cold"],
        )

    async def _get_tools(self) -> list[dict]:
        """Get tool schemas for the LLM request."""
        return self.toolkit.get_schemas()

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

    async def _load_history(self) -> None:
        """Load unified history from agent_messages table.

        Filters out personality prompt (re-injected dynamically in _build_messages).
        """
        if not self.session_store or not self.agent_id:
            return
        try:
            raw = await self.session_store.load_agent_messages(
                self.agent_id, limit=1000
            )
            # Filter out personality system messages (previously saved before refactor)
            # Use 'in' check rather than exact match to tolerate whitespace diffs.
            if self._personality_prompt:
                pp = self._personality_prompt.strip()
                self._messages = [
                    m for m in raw
                    if not (
                        m.role == "system"
                        and isinstance(m.content, str)
                        and pp in m.content.strip()
                    )
                ]
                if len(self._messages) < len(raw):
                    logger.info(
                        "Filtered %d personality messages from loaded history",
                        len(raw) - len(self._messages),
                    )
            else:
                self._messages = raw
            logger.info(
                "Loaded %d messages for agent %s",
                len(self._messages),
                self.agent_id,
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
        if self.embedder and self.memory_store and message.meta.id:
            text = message.get_text()
            if text and len(text) > 5:
                try:
                    vec = await self.embedder.embed_single(text)
                    if vec:
                        self.memory_store.add(
                            agent_id=self.agent_id,
                            message_id=message.meta.id,
                            text=text[:2000],
                            embedding=vec,
                            metadata={
                                "role": message.role,
                                "source": source,
                                "source_name": source_name,
                            },
                        )
                except Exception as e:
                    logger.warning("Failed to index message vector: %s", e)
