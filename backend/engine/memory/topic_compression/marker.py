"""Topic detection via lightweight LLM annotation."""
from __future__ import annotations

import logging
from typing import Optional

from ...message.types import Message
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
        timeout: float = 30.0,
        context_window: int = 64000,
    ):
        self.provider_name = provider_name
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.timeout = timeout
        self.context_window = context_window

    @classmethod
    def from_config(cls, agent_model_config: dict) -> "TopicMarker":
        """Build marker from agent config. Falls back to main provider if no marker config."""
        marker_cfg = agent_model_config.get("marker") or {}
        if marker_cfg.get("provider") and marker_cfg.get("model"):
            provider_name = marker_cfg["provider"]
            model = marker_cfg["model"]
        else:
            provider_name = agent_model_config.get("provider", "deepseek")
            model = agent_model_config.get("model", "deepseek-chat")

        api_key = marker_cfg.get("api_key", "") or agent_model_config.get("api_key", "")
        base_url = marker_cfg.get("base_url", "") or agent_model_config.get("base_url", "")

        if not api_key:
            raise ValueError(f"No API key available for marker provider '{provider_name}'")

        return cls(
            provider_name=provider_name,
            model=model,
            api_key=api_key,
            base_url=base_url,
        )

    @classmethod
    async def from_agent(cls, db, agent_row) -> "TopicMarker":
        """Build marker from Agent row using new independent fields.

        Falls back to from_config(agent_row.model_config) if no marker config.
        Falls back to main model if marker not configured.
        """
        from app.services.provider_resolver import resolve_provider_credentials

        marker_provider_id = agent_row.marker_provider_id
        marker_model_id = agent_row.marker_model_id

        if not marker_provider_id:
            # Fall back to legacy model_config
            return cls.from_config(agent_row.model_config or {})

        creds = await resolve_provider_credentials(db, marker_provider_id, marker_model_id)
        if not creds:
            # Fallback to main model
            creds = await resolve_provider_credentials(
                db, agent_row.provider_id, agent_row.model_id
            )

        if not creds or not creds.api_key:
            raise ValueError(f"No API key available for marker provider '{marker_provider_id}'")

        # Resolve model physical attributes to set appropriate timeout
        from app.services.provider_resolver import resolve_model_attributes
        attrs = await resolve_model_attributes(db, creds.provider_id, creds.model_id)
        timeout = max(30.0, min(180.0, (attrs.context_window or 64000) / 2000))

        return cls(
            provider_name=creds.provider_type,
            model=creds.model_id,
            api_key=creds.api_key,
            base_url=creds.base_url,
            timeout=timeout,
            context_window=attrs.context_window or 64000,
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
            timeout=self.timeout,
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
