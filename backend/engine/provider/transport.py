"""ChatCompletionsTransport - OpenAI-compatible provider transport.

Design reference: §6.2 Provider 层
All four providers (DeepSeek, MiMo, KimiCode, GLM) share this transport.
Differences are handled by ThinkingProfile.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, AsyncIterator

import httpx
from openai import AsyncOpenAI, APIError, APITimeoutError, RateLimitError

from ..message.types import (
    ContentBlock,
    ImageBlock,
    ThinkingBlock,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    Message,
    sanitize_tool_call_ids,
)
from .thinking.base import ThinkingProfile, LLMResponse

logger = logging.getLogger(__name__)


class ChatCompletionsTransport:
    """OpenAI-compatible Chat Completions Transport.

    Handles message formatting, API calls, and response normalization
    for all OpenAI-compatible providers. Provider-specific behavior
    is delegated to the ThinkingProfile.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        thinking_profile: ThinkingProfile,
        timeout: float = 120.0,
        max_retries: int = 3,
    ):
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.thinking_profile = thinking_profile
        self.timeout = timeout
        self.max_retries = max_retries

        self._client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """Send messages and get a complete response.

        Args:
            messages: List of Message objects.
            tools: OpenAI-format tool schemas (optional).
            **kwargs: Additional kwargs passed to the API call.

        Returns:
            LLMResponse with normalized content.
        """
        api_messages = self._format_messages(messages)
        api_kwargs = self._build_request_kwargs(api_messages, tools, kwargs)

        response = await self._call_with_retry(api_kwargs)
        return self._normalize_response(response)

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ContentBlock]:
        """Send messages and stream response chunks.

        Yields ContentBlock instances as they arrive:
        - ThinkingBlock for reasoning content
        - TextBlock for content
        - ToolUseBlock for tool calls (once at end of stream)

        Args:
            messages: List of Message objects.
            tools: OpenAI-format tool schemas (optional).
            **kwargs: Additional kwargs passed to the API call.

        Yields:
            ContentBlock instances.
        """
        api_messages = self._format_messages(messages)
        api_kwargs = self._build_request_kwargs(api_messages, tools, kwargs)
        api_kwargs["stream"] = True

        # Collect tool calls from stream
        tool_calls_accum: dict[int, dict[str, Any]] = {}

        response = await self._client.chat.completions.create(**api_kwargs)

        async for chunk in response:
            if not chunk.choices:
                continue

            choice = chunk.choices[0]
            delta = choice.delta

            # Yield thinking content
            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                yield ThinkingBlock(thinking=delta.reasoning_content)

            # Yield text content
            if delta.content:
                yield TextBlock(text=delta.content)

            # Accumulate tool calls
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index if tc.index is not None else 0
                    if idx not in tool_calls_accum:
                        tool_calls_accum[idx] = {
                            "id": tc.id or str(uuid.uuid4()),
                            "name": tc.function.name if tc.function else "",
                            "arguments": "",
                        }
                    if tc.id:
                        tool_calls_accum[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_calls_accum[idx]["name"] = tc.function.name
                        if tc.function.arguments:
                            tool_calls_accum[idx]["arguments"] += tc.function.arguments

        # Yield accumulated tool calls
        for idx in sorted(tool_calls_accum.keys()):
            tc_data = tool_calls_accum[idx]
            arguments = tc_data["arguments"]
            try:
                parsed_args = json.loads(arguments) if arguments else {}
            except json.JSONDecodeError:
                parsed_args = {"_raw_arguments": arguments}

            yield ToolUseBlock(
                id=tc_data["id"],
                name=tc_data["name"],
                input=parsed_args,
            )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _format_messages(self, messages: list[Message]) -> list[dict]:
        """Convert Message objects to OpenAI-format dicts.

        Design reference: §6.3.3 - Transport 负责将 Message 转为 OpenAI dict.
        """
        # Ensure tool_use / tool_result ids are consistent before serialization.
        sanitize_tool_call_ids(messages)

        api_messages = []
        for msg in messages:
            # Build the content portion
            if isinstance(msg.content, str):
                api_msg = {"role": msg.role, "content": msg.content}
            elif isinstance(msg.content, list):
                # Filter out content blocks for the API
                parts = []
                tool_result_blocks = []
                tool_use_blocks = []

                for block in msg.content:
                    if isinstance(block, TextBlock):
                        parts.append({"type": "text", "text": block.text})
                    elif isinstance(block, ImageBlock):
                        parts.append({"type": "image_url", "image_url": block.source})
                    elif isinstance(block, ThinkingBlock):
                        # Thinking is handled by the provider's thinking profile,
                        # not sent as regular content. It's echoed separately.
                        pass
                    elif isinstance(block, ToolUseBlock):
                        tool_use_blocks.append(block)
                    elif isinstance(block, ToolResultBlock):
                        tool_result_blocks.append(block)

                if tool_use_blocks:
                    # Assistant message with tool calls
                    api_msg = {
                        "role": "assistant",
                        "content": parts[0]["text"] if parts else None,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.input),
                                },
                            }
                            for tc in tool_use_blocks
                        ],
                    }
                    # Include reasoning_content if present
                    thinking_parts = [
                        b for b in msg.content if isinstance(b, ThinkingBlock)
                    ]
                    if thinking_parts:
                        api_msg["reasoning_content"] = "\n".join(
                            t.thinking for t in thinking_parts
                        )

                elif tool_result_blocks:
                    # Tool result message — skip any with empty tool_call_id
                    for tr in tool_result_blocks:
                        if not tr.id:
                            logger.warning("Skipping tool result with empty tool_call_id")
                            continue
                        api_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tr.id,
                                "content": tr.content,
                            }
                        )
                    continue  # Skip the normal message append below

                elif parts:
                    api_msg = {"role": msg.role, "content": parts}
                else:
                    api_msg = {"role": msg.role, "content": ""}

            else:
                continue

            # Handle reasoning_content echo for providers that require it
            if self.thinking_profile.needs_reasoning_echo(
                has_tool_calls=isinstance(msg.content, list)
                and any(isinstance(b, ToolUseBlock) for b in msg.content)
                if isinstance(msg.content, list)
                else False
            ):
                thinking_blocks = [
                    b for b in (msg.content if isinstance(msg.content, list) else [])
                    if isinstance(b, ThinkingBlock)
                ]
                if thinking_blocks:
                    api_msg["reasoning_content"] = "\n".join(
                        t.thinking for t in thinking_blocks
                    )

            # Normalize empty content
            api_msg = self.thinking_profile.normalize_content(api_msg)
            api_messages.append(api_msg)

        return api_messages

    def _build_request_kwargs(
        self,
        api_messages: list[dict],
        tools: list[dict] | None,
        extra_kwargs: dict,
    ) -> dict:
        """Build the full kwargs dict for the API call, including thinking params."""
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": api_messages,
        }
        if tools:
            kwargs["tools"] = tools

        # Inject thinking profile parameters
        kwargs = self.thinking_profile.build_thinking_kwargs(kwargs)

        # Merge any extra kwargs
        kwargs.update(extra_kwargs)

        return kwargs

    async def _call_with_retry(self, api_kwargs: dict) -> Any:
        """Call the API with basic error handling.

        Design reference: §6.9 - Full retry/fallback logic is in the error module.
        This method handles the basic call; the Agent core handles retries.
        """
        try:
            return await self._client.chat.completions.create(**api_kwargs)
        except RateLimitError as e:
            logger.warning("Rate limit hit for %s: %s", self.base_url, e)
            raise
        except APITimeoutError as e:
            logger.warning("Timeout for %s: %s", self.base_url, e)
            raise
        except APIError as e:
            logger.error("API error for %s: %s", self.base_url, e)
            raise

    def _normalize_response(self, response: Any) -> LLMResponse:
        """Normalize a provider response into LLMResponse.

        Uses the ThinkingProfile to extract provider-specific fields.
        """
        choice = response.choices[0]
        message = choice.message

        # Extract content
        content = message.content or None

        # Extract reasoning_content via thinking profile
        reasoning_content = self.thinking_profile.extract(response)

        # Extract tool calls
        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                try:
                    args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except json.JSONDecodeError:
                    args = {"_raw_arguments": tc.function.arguments or ""}
                # Some providers return empty tool_call.id — generate one to keep
                # the API happy (tool_call_id must be non-empty and match)
                tool_call_id = tc.id or str(uuid.uuid4())
                tool_calls.append(
                    {
                        "id": tool_call_id,
                        "name": tc.function.name,
                        "arguments": args,
                    }
                )

        # Extract usage
        usage = {}
        if response.usage:
            usage = {
                "prompt_tokens": response.usage.prompt_tokens or 0,
                "completion_tokens": response.usage.completion_tokens or 0,
                "total_tokens": response.usage.total_tokens or 0,
            }

        return LLMResponse(
            content=content,
            reasoning_content=reasoning_content,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "",
            usage=usage,
            raw=response,
        )