"""Group task workflow engine: executes @序列 plans from conductor in group chat.

Parses conductor output like:
    [搜索] 维克托：搜索 AI Agent 市场
    [分析] 季白：整理报告
into sequential nodes, executes them via AgentWorker, and broadcasts
progress + results back to the group chat.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy import select

from ..database import AsyncSessionLocal
from ..models import Agent, ChatMessage, ChatSessionMember
from .engine_bridge import EngineBridge
from .event_bus import manager

logger = logging.getLogger(__name__)

# session_id -> True  (stop signal)
_stop_signals: Dict[str, bool] = {}

# session_id -> GroupTaskEngine  (active tasks)
_active_tasks: Dict[str, "GroupTaskEngine"] = {}

# session_id -> (engine, completed_at)  (recently completed tasks, TTL 10 min)
_completed_tasks: Dict[str, tuple["GroupTaskEngine", datetime]] = {}


def _cleanup_completed_tasks() -> None:
    now = datetime.now(timezone.utc)
    stale = [
        sid for sid, (_, ts) in _completed_tasks.items()
        if (now - ts).total_seconds() > 600
    ]
    for sid in stale:
        del _completed_tasks[sid]


class GroupTaskEngine:
    """Executes a parsed task plan inside a group chat."""

    def __init__(
        self,
        session_id: str,
        user_id: str,
        conductor_id: str,
        plan_text: str,
    ):
        self.session_id = session_id
        self.user_id = user_id
        self.conductor_id = conductor_id
        self.plan_text = plan_text
        self.nodes: List[dict] = []
        self.results: List[dict] = []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @classmethod
    def stop_session(cls, session_id: str) -> None:
        """User sent a new message — cancel any running task for this session."""
        _stop_signals[session_id] = True
        engine = _active_tasks.pop(session_id, None)
        if engine:
            logger.info("Task for session %s stopped by user", session_id)

    @classmethod
    def is_running(cls, session_id: str) -> bool:
        return session_id in _active_tasks

    @classmethod
    def get_active_engine(cls, session_id: str) -> Optional["GroupTaskEngine"]:
        engine = _active_tasks.get(session_id)
        if engine:
            return engine
        _cleanup_completed_tasks()
        pair = _completed_tasks.get(session_id)
        return pair[0] if pair else None

    async def execute(self, bridge: EngineBridge) -> None:
        """Main entry — parse plan, run nodes, conductor summary."""
        _active_tasks[self.session_id] = self
        _stop_signals.pop(self.session_id, None)

        try:
            agent_map = await self._build_agent_map()
            self.nodes = self._parse_plan(self.plan_text, agent_map)

            if not self.nodes:
                await self._send_system("未能解析任务计划，格式示例：\n[搜索] 维克托：搜索 AI Agent 市场")
                return

            await self._send_system(f"任务开始执行，共 {len(self.nodes)} 个步骤。")

            for idx, node in enumerate(self.nodes):
                if _stop_signals.get(self.session_id):
                    await self._send_system("任务已取消。")
                    return

                await self._run_node(bridge, node)

            if _stop_signals.get(self.session_id):
                await self._send_system("任务已取消。")
                return

            await self._run_conductor_summary(bridge)
            await self._send_system("任务执行完毕。输入「保存这个流程」可存入行动中心。")

        except Exception:
            logger.exception("GroupTaskEngine execute failed")
            await self._send_system("任务执行出错，已终止。")
        finally:
            _active_tasks.pop(self.session_id, None)
            _stop_signals.pop(self.session_id, None)
            # Keep in completed buffer so user can save blueprint
            _completed_tasks[self.session_id] = (self, datetime.now(timezone.utc))

    def to_blueprint(self) -> dict:
        """Convert to Action blueprint for saving to ActionCenter."""
        nodes = []
        for i, n in enumerate(self.nodes):
            nodes.append({
                "id": n["id"],
                "type": "agent",
                "x": i * 200,
                "y": 100,
                "agent_id": n["agent_id"],
                "instruction": n["instruction"],
                "timeout_seconds": 300,
                "requires_approval": False,
                "is_critical": False,
            })
        edges = []
        for i in range(len(nodes) - 1):
            edges.append({"source": nodes[i]["id"], "target": nodes[i + 1]["id"]})
        return {
            "name": "群聊任务蓝图",
            "description": self.plan_text[:300],
            "nodes": nodes,
            "edges": edges,
        }

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_plan(text: str, agent_map: dict) -> List[dict]:
        """Parse plan lines like '[搜索] 维克托：搜索 AI Agent 市场'."""
        nodes = []
        # Match: [step_name] agent_ref: instruction
        pattern = re.compile(r"^\s*\[([^\]]+)\]\s*([^：:]+)[：:]\s*(.+)$", re.MULTILINE)
        for m in pattern.finditer(text):
            step = m.group(1).strip()
            agent_ref = m.group(2).strip()
            instruction = m.group(3).strip()

            agent_id = agent_map.get(agent_ref)
            if not agent_id:
                # case-insensitive fallback
                for k, v in agent_map.items():
                    if k.lower() == agent_ref.lower():
                        agent_id = v
                        break

            if agent_id:
                nodes.append({
                    "id": f"node_{len(nodes)}",
                    "step": step,
                    "agent_id": agent_id,
                    "instruction": instruction,
                })
        return nodes

    async def _build_agent_map(self) -> dict:
        """Return {name/codename/alias -> agent_id} for all agents in session."""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ChatSessionMember).where(
                    ChatSessionMember.session_id == self.session_id,
                    ChatSessionMember.member_type == "agent",
                )
            )
            members = result.scalars().all()
            agent_map: dict = {}
            for m in members:
                agent = await db.execute(select(Agent).where(Agent.id == m.member_id))
                a = agent.scalar_one_or_none()
                if a:
                    agent_map[a.name] = a.id
                    agent_map[a.codename] = a.id
                    for alias in a.aliases or []:
                        agent_map[alias] = a.id
            return agent_map

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def _run_node(self, bridge: EngineBridge, node: dict) -> None:
        agent_id = node["agent_id"]
        instruction = node["instruction"]
        step = node["step"]

        await self._send_typing(agent_id, True)
        full_output = ""

        try:
            engine_sid = f"task:{self.session_id}:{node['id']}"
            async for event in bridge.stream_chat(
                agent_id=agent_id,
                session_id=engine_sid,
                user_message=instruction,
                source="group",
                source_name=f"任务-{step}",
                sender_name="系统",
            ):
                if _stop_signals.get(self.session_id):
                    break
                if event.get("type") == "content":
                    full_output += event.get("data", {}).get("text", "")
                elif event.get("type") == "thinking":
                    thinking_text = event.get("data", {}).get("thinking", "")
                    if thinking_text:
                        await self._send_thinking(agent_id, thinking_text, batch_id=node["id"])
                elif event.get("type") == "tool_call":
                    tool_name = event.get("data", {}).get("name", "")
                    tool_input = event.get("data", {}).get("input", {})
                    if tool_name:
                        await self._send_tool_call(agent_id, tool_name, tool_input, batch_id=node["id"])

            await self._send_typing(agent_id, False)

            if full_output:
                self.results.append({"step": step, "agent_id": agent_id, "output": full_output})
                await self._send_agent_msg(agent_id, full_output)
                # Persist to DB so history is complete
                await self._persist_agent_msg(agent_id, full_output)
            else:
                await self._send_system(f"步骤 [{step}] 未产生输出。")

        except Exception as exc:
            logger.exception("Task node %s failed", node["id"])
            await self._send_typing(agent_id, False)
            await self._send_system(f"步骤 [{step}] 执行失败: {exc}")

    async def _run_conductor_summary(self, bridge: EngineBridge) -> None:
        prompt_lines = ["以下是各步骤的执行结果，请汇总成一份完整的报告：", ""]
        for r in self.results:
            prompt_lines.append(f"[{r['step']}]:\n{r['output'][:800]}")
        prompt_lines.append("")
        prompt_lines.append("请输出最终的汇总报告。")
        prompt = "\n".join(prompt_lines)

        await self._send_typing(self.conductor_id, True)
        full_output = ""

        try:
            engine_sid = f"task:{self.session_id}:summary"
            async for event in bridge.stream_chat(
                agent_id=self.conductor_id,
                session_id=engine_sid,
                user_message=prompt,
                source="group",
                source_name="任务-汇总",
                sender_name="系统",
            ):
                if event.get("type") == "content":
                    full_output += event.get("data", {}).get("text", "")

            await self._send_typing(self.conductor_id, False)

            if full_output:
                await self._send_agent_msg(self.conductor_id, full_output)
                await self._persist_agent_msg(self.conductor_id, full_output)
        except Exception:
            logger.exception("Conductor summary failed")
            await self._send_typing(self.conductor_id, False)

    # ------------------------------------------------------------------
    # Broadcast helpers
    # ------------------------------------------------------------------

    async def _send_thinking(self, agent_id: str, thinking: str, batch_id: str = "") -> None:
        frame = {
            "type": "chat.thinking",
            "payload": {
                "session_id": self.session_id,
                "agent_id": agent_id,
                "agent_name": await self._agent_name(agent_id),
                "thinking": thinking,
                "batch_id": batch_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }
        await self._broadcast(frame)

    async def _send_tool_call(self, agent_id: str, tool_name: str, tool_input: dict, batch_id: str = "") -> None:
        frame = {
            "type": "chat.tool_call",
            "payload": {
                "session_id": self.session_id,
                "agent_id": agent_id,
                "agent_name": await self._agent_name(agent_id),
                "tool_name": tool_name,
                "tool_input": tool_input,
                "batch_id": batch_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }
        await self._broadcast(frame)

    async def _send_system(self, content: str) -> None:
        frame = {
            "type": "chat.message",
            "payload": {
                "session_id": self.session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": "system",
                    "sender_type": "system",
                    "sender_name": "系统",
                    "content": content,
                    "content_type": "text",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "is_me": False,
                },
            },
        }
        await self._broadcast(frame)

    async def _send_agent_msg(self, agent_id: str, content: str) -> None:
        name = await self._agent_name(agent_id)
        frame = {
            "type": "chat.message",
            "payload": {
                "session_id": self.session_id,
                "message": {
                    "id": str(uuid.uuid4()),
                    "sender_id": agent_id,
                    "sender_type": "agent",
                    "sender_name": name,
                    "content": content,
                    "content_type": "text",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "is_me": False,
                },
            },
        }
        await self._broadcast(frame)

    async def _send_typing(self, agent_id: str, is_typing: bool) -> None:
        frame = {
            "type": "chat.typing",
            "payload": {
                "session_id": self.session_id,
                "user_id": agent_id,
                "is_typing": is_typing,
            },
        }
        await self._broadcast(frame)

    async def _broadcast(self, frame: dict) -> None:
        """Send to all online user members of the session."""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(ChatSessionMember).where(
                    ChatSessionMember.session_id == self.session_id,
                    ChatSessionMember.member_type == "user",
                )
            )
            members = result.scalars().all()
            for m in members:
                await manager.send_to_user(m.member_id, frame)

    async def _persist_agent_msg(self, agent_id: str, content: str) -> None:
        async with AsyncSessionLocal() as db:
            msg = ChatMessage(
                id=str(uuid.uuid4()),
                session_id=self.session_id,
                sender_id=agent_id,
                sender_type="agent",
                content=content,
            )
            db.add(msg)
            await db.commit()

    async def _agent_name(self, agent_id: str) -> str:
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Agent).where(Agent.id == agent_id))
            a = result.scalar_one_or_none()
            return a.name if a else "Agent"


# ------------------------------------------------------------------
# Public launcher
# ------------------------------------------------------------------
async def launch_group_task(
    session_id: str,
    user_id: str,
    conductor_id: str,
    plan_text: str,
    bridge: EngineBridge,
) -> None:
    """Fire-and-forget group task execution."""
    engine = GroupTaskEngine(
        session_id=session_id,
        user_id=user_id,
        conductor_id=conductor_id,
        plan_text=plan_text,
    )
    asyncio.create_task(engine.execute(bridge))
