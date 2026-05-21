"""FastAPI application.

Design reference: §6.13 FastAPI 对外接口
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import shortuuid
from fastapi import FastAPI, WebSocket

from ..agent.pool import AgentPool
from ..agent.react import ReActAgent
from ..config.loader import load_config
from ..context.manager import ContextManager
from ..logging_.formatter import setup_logging
from ..provider.thinking.deepseek import DeepSeekThinkingProfile
from ..provider.transport import ChatCompletionsTransport
from ..session.store import SessionStore
from ..tool.registry import tool_registry

logger = logging.getLogger(__name__)


def _generate_session_id() -> str:
    return f"sess_{shortuuid.uuid()[:12]}"


def create_app() -> FastAPI:
    config = load_config()

    # Shared transport (stateless, safe for concurrent use)
    provider_cfg = getattr(config.provider, config.provider.default or "deepseek")
    transport = ChatCompletionsTransport(
        base_url=provider_cfg.base_url,
        api_key=provider_cfg.api_key,
        model="deepseek-v4-pro",
        thinking_profile=DeepSeekThinkingProfile(),
    )

    # Shared infrastructure
    session_store = SessionStore()
    context_manager = ContextManager(
        config=config.context,
        model=transport,
        session_store=session_store,
    )

    def agent_factory(session_id: str) -> ReActAgent:
        return ReActAgent(
            name=f"agent_{session_id[:8]}",
            model=transport,
            toolkit=tool_registry,
            context_manager=context_manager,
            session_store=session_store,
            session_id=session_id,
            config=config,
        )

    agent_pool = AgentPool(agent_factory=agent_factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Application lifespan: startup and graceful shutdown."""
        setup_logging(level="INFO", log_dir="~/.agenschedule/logs")
        logger.info("AgentPool initialized (max_agents=%d)", agent_pool.max_agents)
        yield
        logger.info("Shutting down: saving %d active agents", len(agent_pool.list_active()))
        await agent_pool.clear()
        await session_store.close()

    app = FastAPI(
        title="ANewAgentToolScheduling",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.state.config = config
    app.state.session_store = session_store
    app.state.context_manager = context_manager
    app.state.agent_pool = agent_pool

    @app.post("/run")
    async def run(message: str, session_id: str | None = None):
        """Non-streaming endpoint: collect all events, return final answer."""
        sid = session_id or _generate_session_id()
        result = ""

        async with agent_pool.acquire(sid) as agent:
            async for event in agent.stream(message, session_id=sid):
                if event.type == "content":
                    result += event.data.text if hasattr(event.data, "text") else str(event.data)
                elif event.type == "done":
                    break

        return {"answer": result, "session_id": sid}

    @app.websocket("/stream")
    async def stream(ws: WebSocket):
        """Streaming endpoint via WebSocket."""
        await ws.accept()
        try:
            while True:
                data = await ws.receive_json()
                message = data.get("message", "")
                session_id = data.get("session_id") or _generate_session_id()

                async with agent_pool.acquire(session_id) as agent:
                    async for event in agent.stream(message, session_id=session_id):
                        await ws.send_json(event.to_dict())
                        if event.type == "done":
                            break
        except Exception as e:
            logger.error("WebSocket error: %s", e)
            await ws.send_json({"type": "error", "message": str(e)})

    @app.get("/session/{session_id}")
    async def get_session(session_id: str):
        """Get session history."""
        messages = await session_store.load_messages(session_id)
        return {
            "session_id": session_id,
            "messages": [
                {
                    "role": msg.role,
                    "content": msg.get_text() if hasattr(msg, "get_text") else str(msg.content),
                }
                for msg in messages
            ],
        }

    return app


app = create_app()
