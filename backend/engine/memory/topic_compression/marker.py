"""Topic detection via lightweight LLM annotation."""
from __future__ import annotations

import logging
from typing import Optional

from ...message.types import Message
from ...provider.registry import get_registry

logger = logging.getLogger(__name__)

_TOPIC_MARKER_PROMPT = """Analyze the following conversation context and determine the current topic domain and importance.

Recent messages:
{context}

Output EXACTLY one of:
- "Domain-SpecificTopic|high" (for important/work topics)
- "Domain-SpecificTopic|normal" (for regular topics)
- "Domain-SpecificTopic|low" (for casual/chitchat)
- "same" (if topic unchanged)
- "unknown" (if cannot determine)

Rules:
- Domain should be a broad category (e.g., 代码, 力学, 闲聊, 数学)
- SpecificTopic should be concise (3-10 chars)
- Use Chinese or English as appropriate
- No explanation, no markdown, just the single line output."""


class TopicMarker:
    def __init__(
        self,
        provider_name: str,
        model: str,
        api_key: str,
        base_url: str,
    ):
        self.provider_name = provider_name
        self.model = model
        self.api_key = api_key
        self.base_url = base_url

    @classmethod
    def from_config(cls, agent_model_config: dict) -> "TopicMarker":
        """Build marker from agent config. Falls back to main provider if no marker config."""
        marker_cfg = agent_model_config.get("marker")
        if marker_cfg:
            provider_name = marker_cfg["provider"]
            model = marker_cfg["model"]
        else:
            provider_name = agent_model_config["provider"]
            provider = get_registry().get(provider_name)
            model = provider.marker_model or provider.default_model

        provider = get_registry().get(provider_name)
        return cls(
            provider_name=provider_name,
            model=model,
            api_key=provider.api_key,
            base_url=provider.base_url,
        )

    async def detect(self, recent_messages: list[Message]) -> Optional[str]:
        """Return label like '代码-重构|high' or 'same' or 'unknown'."""
        from ...provider.transport import ChatCompletionsTransport
        from ...provider.thinking.plain import PlainThinkingProfile

        context = "\n".join(
            f"{m.role}: {m.get_text()[:200]}" for m in recent_messages[-5:]
        )
        prompt = _TOPIC_MARKER_PROMPT.format(context=context)

        transport = ChatCompletionsTransport(
            base_url=self.base_url,
            api_key=self.api_key,
            model=self.model,
            thinking_profile=PlainThinkingProfile(),
            timeout=30.0,
        )

        try:
            response = await transport.chat(
                messages=[Message(role="user", content=prompt)],
                tools=None,
            )
            text = (response.content or "").strip()
            # Clean up
            if text.startswith('"') and text.endswith('"'):
                text = text[1:-1]
            return text if text in ("same", "unknown") or "|" in text else "unknown"
        except Exception as e:
            logger.warning("TopicMarker failed: %s", e)
            return "unknown"
