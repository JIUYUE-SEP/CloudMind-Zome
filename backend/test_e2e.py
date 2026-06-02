"""End-to-end smoke test: verify Agent Worker, routing, workflow wiring
without requiring a real LLM API key.

Usage: cd backend && py test_e2e.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from engine.provider.transport import ChatCompletionsTransport
from engine.message.types import Message, TextBlock


class MockTransport(ChatCompletionsTransport):
    """Fake LLM that echoes back simple responses."""

    def __init__(self):
        # Bypass base __init__ — we don't need real credentials
        self.base_url = "mock"
        self.api_key = "mock"
        self.model = "mock"
        self.thinking_profile = None

    async def chat(self, messages, tools=None):
        class FakeResponse:
            content = "这是模拟回复。"
            reasoning_content = ""
            tool_calls = None
            usage = {"total_tokens": 10}
        return FakeResponse()


# Patch the AgentWorker transport builder so it never hits real APIs
_original_build_transport = None


def _patch_transport():
    from app.services import agent_worker
    global _original_build_transport
    _original_build_transport = agent_worker.AgentWorker._build_transport

    async def _mock_build_transport(self):
        return MockTransport()

    agent_worker.AgentWorker._build_transport = _mock_build_transport


def _unpatch_transport():
    from app.services import agent_worker
    if _original_build_transport:
        agent_worker.AgentWorker._build_transport = _original_build_transport


async def _setup_db():
    from app.database import AsyncSessionLocal
    from app.models import Agent, User, ChatSession, ChatSessionMember
    import uuid

    async with AsyncSessionLocal() as db:
        # Guest user
        user = User(
            id="00000000-0000-0000-0000-000000000001",
            codename="test_user",
            nickname="测试用户",
            password_hash=None,
            device_id="test",
            role="user",
        )
        db.add(user)

        # Agent
        agent = Agent(
            id="00000000-0000-0000-0000-000000000002",
            user_id=user.id,
            name="测试心智",
            codename="test_agent",
            personality_prompt="你是一个测试用的数字生命。",
            model_config={"provider": "deepseek", "model": "mock"},
            status="idle",
        )
        db.add(agent)

        # Private chat session
        sess = ChatSession(
            id="00000000-0000-0000-0000-000000000003",
            type="private",
            owner_id=user.id,
        )
        db.add(sess)
        db.add(ChatSessionMember(session_id=sess.id, member_id=user.id, member_type="user"))
        db.add(ChatSessionMember(session_id=sess.id, member_id=agent.id, member_type="agent"))

        # Group chat session
        group = ChatSession(
            id="00000000-0000-0000-0000-000000000004",
            type="group",
            owner_id=user.id,
            settings={"name": "测试群", "routing_mode": "mention"},
        )
        db.add(group)
        db.add(ChatSessionMember(session_id=group.id, member_id=user.id, member_type="user"))
        db.add(ChatSessionMember(session_id=group.id, member_id=agent.id, member_type="agent"))

        await db.commit()
        return user.id, agent.id, sess.id, group.id


async def test_private_chat(agent_id: str, session_id: str):
    from app.services.agent_worker import ensure_worker, dispatch_job
    from app.services.job_queue import AgentJob

    chunks = []

    async def on_chunk(text: str):
        chunks.append(text)

    async def on_done(text: str, ok: bool):
        pass

    job = AgentJob(
        source="private",
        source_id=session_id,
        source_name="私聊",
        sender_name="测试用户",
        content="你好",
        on_chunk=on_chunk,
        on_done=on_done,
    )
    await dispatch_job(agent_id, job)
    # Wait for processing (mock is instant)
    await asyncio.sleep(1.5)
    assert len(chunks) > 0, "Private chat did not produce chunks"
    print(f"[PASS] Private chat: {len(chunks)} chunks, last='{chunks[-1][:30]}...'")


async def test_group_mention(agent_id: str, session_id: str):
    from app.services.group_chat_router import GroupChatRouter
    from app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        router = GroupChatRouter(db)
        from app.models import ChatSession
        result = await db.execute(
            __import__("sqlalchemy", fromlist=["select"]).select(ChatSession).where(ChatSession.id == session_id)
        )
        session = result.scalar_one()
        targets = await router.route(session, "00000000-0000-0000-0000-000000000001", "@测试心智 在吗")

    assert len(targets) == 1 and targets[0].agent_id == agent_id
    print("[PASS] Group mention routing correct")


async def test_workflow(agent_id: str):
    from app.services.workflow_engine import WorkflowEngine
    from app.database import AsyncSessionLocal
    from app.models import Action, ActionRun
    import uuid

    async with AsyncSessionLocal() as db:
        action = Action(
            id=str(uuid.uuid4()),
            user_id="00000000-0000-0000-0000-000000000001",
            name="测试工作流",
            nodes=[{
                "id": "n1",
                "agent_id": agent_id,
                "instruction": "执行测试指令",
                "timeout_seconds": 60,
            }],
        )
        db.add(action)
        run = ActionRun(
            id=str(uuid.uuid4()),
            action_id=action.id,
            user_id="00000000-0000-0000-0000-000000000001",
            status="pending",
        )
        db.add(run)
        await db.commit()
        run_id = run.id

    engine = WorkflowEngine(run_id=run_id, user_id="00000000-0000-0000-0000-000000000001")
    await engine.execute()

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            __import__("sqlalchemy", fromlist=["select"]).select(ActionRun).where(ActionRun.id == run_id)
        )
        run_after = result.scalar_one()
        assert run_after.status == "completed", f"Workflow status: {run_after.status}"
        print(f"[PASS] Workflow completed, node_states={run_after.node_states}")


async def test_commission(agent_id: str):
    from app.services.commission_scheduler import CommissionScheduler
    from app.database import AsyncSessionLocal
    from app.models import Commission
    import uuid

    async with AsyncSessionLocal() as db:
        comm = Commission(
            id=str(uuid.uuid4()),
            user_id="00000000-0000-0000-0000-000000000001",
            agent_id=agent_id,
            name="测试委托",
            trigger_type="manual",
            trigger_config={},
            action_type="preset_chat",
            action_config={"instruction": "测试委托执行"},
            status="active",
            next_run_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        )
        db.add(comm)
        await db.commit()

    scheduler = CommissionScheduler(interval_seconds=5)
    await scheduler._tick()

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            __import__("sqlalchemy", fromlist=["select"]).select(Commission).where(Commission.id == comm.id)
        )
        comm_after = result.scalar_one()
        assert comm_after.last_run_at is not None
        print("[PASS] Commission executed and last_run_at updated")


async def main():
    _patch_transport()
    try:
        # Init engine infra (same as lifespan)
        from app.main import _app_state
        from engine.config.loader import load_config
        from engine.session.store import SessionStore
        from engine.tool.registry import tool_registry

        cfg = load_config(_BACKEND_DIR / "engine" / "config.yaml")
        store = SessionStore()
        await store.connect()
        _app_state["config"] = cfg
        _app_state["session_store"] = store

        user_id, agent_id, sess_id, group_id = await _setup_db()
        print(f"Setup complete: user={user_id}, agent={agent_id}")

        await test_private_chat(agent_id, sess_id)
        await test_group_mention(agent_id, group_id)
        await test_workflow(agent_id)
        await test_commission(agent_id)

        print("\n=== ALL E2E TESTS PASSED ===")
    finally:
        _unpatch_transport()


if __name__ == "__main__":
    asyncio.run(main())
