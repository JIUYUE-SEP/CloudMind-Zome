"""ChatCompletionsTransport - OpenAI-compatible provider transport.

Design reference: §6.2 Provider 层
All four providers (DeepSeek, MiMo, KimiCode, GLM) share this transport.
Differences are handled by ThinkingProfile.
"""

from __future__ import annotations

import asyncio
import json
import logging
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
)
from .thinking.base import ThinkingProfile, LLMResponse

logger = logging.getLogger(__name__)


class ChatCompletionsTransport:
    """OpenAI-compatible Chat Completions Transport.

    Responsibilities:
      1. Format Message objects into OpenAI API dicts.
      2. Call the API (with basic retry).
      3. Normalize responses into LLMResponse.

    It does NOT modify Message objects, fix ids, or validate data.
    Those are upstream concerns (see ToolUseBlock.__post_init__).
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
        """Send messages and get a complete response."""
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
        """Send messages and stream response chunks."""
        api_messages = self._format_messages(messages)
        api_kwargs = self._build_request_kwargs(api_messages, tools, kwargs)
        api_kwargs["stream"] = True

        tool_calls_accum: dict[int, dict[str, Any]] = {}
        response = await self._client.chat.completions.create(**api_kwargs)

        async for chunk in response:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                yield ThinkingBlock(thinking=delta.reasoning_content)
            if delta.content:
                yield TextBlock(text=delta.content)
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index if tc.index is not None else 0
                    if idx not in tool_calls_accum:
                        tool_calls_accum[idx] = {
                            "id": tc.id or "",
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

        Transport is a pure formatter: it trusts that ToolUseBlock.id and
        ToolResultBlock.id are already consistent (enforced upstream).
        """
        api_messages: list[dict] = []
        for msg in messages:
            parts: list[dict] = []
            tool_result_blocks: list[ToolResultBlock] = []
            tool_use_blocks: list[ToolUseBlock] = []

            for block in msg.content:
                if isinstance(block, TextBlock):
                    parts.append({"type": "text", "text": block.text})
                elif isinstance(block, ImageBlock):
                    parts.append({"type": "image_url", "image_url": block.source})
                elif isinstance(block, ToolUseBlock):
                    tool_use_blocks.append(block)
                elif isinstance(block, ToolResultBlock):
                    tool_result_blocks.append(block)
                # ThinkingBlock is skipped — handled by thinking_profile

            if tool_use_blocks:
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
                if any(isinstance(b, ThinkingBlock) for b in msg.content):
                    api_msg["reasoning_content"] = "\n".join(
                        b.thinking for b in msg.content if isinstance(b, ThinkingBlock)
                    )

            elif tool_result_blocks:
                for tr in tool_result_blocks:
                    api_messages.append({
                        "role": "tool",
                        "tool_call_id": tr.id,
                        "content": tr.content,
                    })
                continue

            elif parts:
                api_msg = {"role": msg.role, "content": parts}
            else:
                api_msg = {"role": msg.role, "content": ""}

            # reasoning_content echo for providers that need it
            if self.thinking_profile.needs_reasoning_echo(has_tool_calls=bool(tool_use_blocks)):
                thinking_parts = [
                    b.thinking for b in msg.content if isinstance(b, ThinkingBlock)
                ]
                if thinking_parts:
                    api_msg["reasoning_content"] = "\n".join(thinking_parts)

            api_msg = self.thinking_profile.normalize_content(api_msg)
            api_messages.append(api_msg)

        # Defensive: drop orphaned tool messages whose tool_call_id
        # does not match any preceding assistant tool_call.
        # This guards against historical data corruption.
        valid_ids = set()
        clean: list[dict] = []
        for m in api_messages:
            if m.get("role") == "assistant" and "tool_calls" in m:
                for tc in m["tool_calls"]:
                    valid_ids.add(tc.get("id", ""))
                clean.append(m)
            elif m.get("role") == "tool":
                tid = m.get("tool_call_id", "")
                if tid and tid in valid_ids:
                    clean.append(m)
                else:
                    logger.warning("Dropping orphaned tool message: tool_call_id=%r", tid)
            else:
                clean.append(m)
        return clean

    def _build_request_kwargs(
        self,
        api_messages: list[dict],
        tools: list[dict] | None,
        extra_kwargs: dict,
    ) -> dict:
        kwargs: dict[str, Any] = {"model": self.model, "messages": api_messages}
        if tools:
            kwargs["tools"] = tools
        kwargs = self.thinking_profile.build_thinking_kwargs(kwargs)
        kwargs.update(extra_kwargs)
        return kwargs

    async def _call_with_retry(self, api_kwargs: dict) -> Any:
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
        choice = response.choices[0]
        message = choice.message

        content = message.content or None
        reasoning_content = self.thinking_profile.extract(response)

        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                try:
                    args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except json.JSONDecodeError:
                    args = {"_raw_arguments": tc.function.arguments or ""}
                tool_calls.append({
                    "id": tc.id or "",
                    "name": tc.function.name,
                    "arguments": args,
                })

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
