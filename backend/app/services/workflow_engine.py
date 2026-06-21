"""Linear workflow execution engine.

Sequentially executes Action nodes, each delegated to an Agent via EngineBridge.
Supports approval checkpoints, progress streaming via WebSocket, and stop signals.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import Action, ActionRun, Approval
from ..services.engine_bridge import EngineBridge
from ..services.event_bus import manager

logger = logging.getLogger(__name__)

# Global stop signals: run_id -> True
_stop_signals: Dict[str, bool] = {}


class WorkflowEngine:
    """Executes a linear workflow (list of nodes) sequentially."""

    def __init__(
        self,
        run_id: str,
    ):
        self.run_id = run_id
        self._logs: List[str] = []
        self._node_states: List[dict] = []

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    async def execute(self) -> None:
        """Main entry: load run, then execute nodes sequentially."""
        async with AsyncSessionLocal() as db:
            run = await self._get_run(db)
            if not run:
                logger.error("Run %s not found", self.run_id)
                return

            action = await self._get_action(db, run.action_id)
            if not action:
                logger.error("Action for run %s not found", self.run_id)
                return

            nodes: List[dict] = action.nodes or []
            if not nodes:
                run.status = "completed"
                run.ended_at = datetime.now(timezone.utc)
                await db.commit()
                return

            run.status = "running"
            run.started_at = datetime.now(timezone.utc)
            run.node_states = []
            await db.commit()

        # Initialize node states
        self._node_states = [
            {"node_id": n.get("id", f"n{i}"), "status": "pending", "output": ""}
            for i, n in enumerate(nodes)
        ]
        await self._persist_node_states()

        # Execute each node
        for idx, node in enumerate(nodes):
            if _stop_signals.get(self.run_id):
                await self._mark_stopped()
                return

            success = await self._execute_node(node, idx)
            if not success:
                # Critical node failed -> stop workflow
                if node.get("is_critical"):
                    await self._mark_failed(f"Critical node {node.get('id')} failed")
                    return
                # Non-critical: continue with warning
                self._log(f"Node {node.get('id')} failed but is non-critical, continuing...")

        await self._mark_completed()

    # ------------------------------------------------------------------
    # Node execution
    # ------------------------------------------------------------------

    async def _execute_node(self, node: dict, idx: int) -> bool:
        node_id = node.get("id", f"n{idx}")
        agent_id = node.get("agent_id", "")
        instruction = node.get("instruction", "")
        requires_approval = node.get("requires_approval", False)

        self._set_node_status(idx, "running")
        await self._persist_node_states()
        self._log(f"[{node_id}] Starting: {instruction[:60]}...")
        await self._push_progress(node_id, "running", idx + 1, len(self._node_states))

        # Approval checkpoint
        if requires_approval:
            approval_id = await self._create_approval(node)
            self._set_node_status(idx, "waiting_approval")
            await self._persist_node_states()
            self._log(f"[{node_id}] Waiting for approval {approval_id}")
            await self._push_progress(node_id, "waiting_approval", idx + 1, len(self._node_states))

            # Wait for approval (poll every 2s, max 5 min for MVP)
            approved = await self._wait_for_approval(approval_id, timeout=300)
            if not approved:
                self._set_node_status(idx, "failed")
                await self._persist_node_states()
                self._log(f"[{node_id}] Approval rejected or timed out")
                await self._push_progress(node_id, "failed", idx + 1, len(self._node_states))
                return False

        # Run agent (blocking via AgentWorker queue)
        state = self._engine_state()
        bridge = EngineBridge(
            session_store=state["session_store"],
            app_config=state["config"],
        )

        engine_session_id = f"wf:{self.run_id}:{node_id}"
        full_output = ""

        try:
            # Use run_sync which blocks until the AgentWorker processes the Job
            full_output = await bridge.run_sync(
                agent_id=agent_id,
                session_id=engine_session_id,
                instruction=instruction,
                source_name=f"工作流节点 {node_id}",
            )
            if _stop_signals.get(self.run_id):
                return False

            self._log(f"[{node_id}] {full_output[:200]}")
            self._set_node_status(idx, "completed", output=full_output)
            await self._persist_node_states()
            self._log(f"[{node_id}] Completed")
            await self._push_progress(node_id, "completed", idx + 1, len(self._node_states))
            return True

        except Exception as exc:
            logger.exception("Node execution failed")
            self._set_node_status(idx, "failed", output=str(exc))
            await self._persist_node_states()
            self._log(f"[{node_id}] Failed: {exc}")
            await self._push_progress(node_id, "failed", idx + 1, len(self._node_states))
            return False

    # ------------------------------------------------------------------
    # Approval
    # ------------------------------------------------------------------

    async def _create_approval(self, node: dict) -> str:
        async with AsyncSessionLocal() as db:
            approval = Approval(
                id=str(uuid.uuid4()),
                agent_id=node.get("agent_id", ""),
                tool="workflow_node",
                command=node.get("instruction", "")[:500],
                source="workflow",
                source_id=self.run_id,
                status="pending",
                timeout_seconds=node.get("timeout_seconds", 300),
                expires_at=datetime.now(timezone.utc) + timedelta(seconds=node.get("timeout_seconds", 300)),
            )
            db.add(approval)
            await db.commit()
            return approval.id

    async def _wait_for_approval(self, approval_id: str, timeout: float = 300) -> bool:
        """Poll approvals table until resolved, timeout, or run/action is cancelled."""
        start = datetime.now(timezone.utc)
        while True:
            async with AsyncSessionLocal() as db:
                result = await db.execute(select(Approval).where(Approval.id == approval_id))
                appr = result.scalar_one_or_none()
                if appr:
                    if appr.status == "approved":
                        return True
                    if appr.status in ("rejected", "timeout"):
                        return False

                # Also abort if the run or action has been deleted/stopped.
                run = await self._get_run(db)
                if run and run.status in ("stopped", "failed"):
                    return False

            await asyncio.sleep(2)
            elapsed = (datetime.now(timezone.utc) - start).total_seconds()
            if elapsed > timeout:
                # Auto-timeout
                async with AsyncSessionLocal() as db:
                    result = await db.execute(select(Approval).where(Approval.id == approval_id))
                    appr = result.scalar_one_or_none()
                    if appr and appr.status == "pending":
                        appr.status = "timeout"
                        await db.commit()
                return False

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    async def _persist_node_states(self) -> None:
        async with AsyncSessionLocal() as db:
            run = await self._get_run(db)
            if run:
                run.node_states = self._node_states
                run.logs = "\n".join(self._logs)
                await db.commit()

    async def _mark_completed(self) -> None:
        async with AsyncSessionLocal() as db:
            run = await self._get_run(db)
            if run:
                run.status = "completed"
                run.ended_at = datetime.now(timezone.utc)
                run.node_states = self._node_states
                run.logs = "\n".join(self._logs)
                await db.commit()
        await self._push_progress("", "completed", len(self._node_states), len(self._node_states))
        _stop_signals.pop(self.run_id, None)

    async def _mark_failed(self, reason: str) -> None:
        async with AsyncSessionLocal() as db:
            run = await self._get_run(db)
            if run:
                run.status = "failed"
                run.ended_at = datetime.now(timezone.utc)
                run.node_states = self._node_states
                run.logs = "\n".join(self._logs) + f"\n[FAILED] {reason}"
                await db.commit()
        await self._push_progress("", "failed", 0, len(self._node_states))
        _stop_signals.pop(self.run_id, None)

    async def _mark_stopped(self) -> None:
        async with AsyncSessionLocal() as db:
            run = await self._get_run(db)
            if run:
                run.status = "stopped"
                run.ended_at = datetime.now(timezone.utc)
                run.node_states = self._node_states
                run.logs = "\n".join(self._logs) + "\n[STOPPED] User requested stop"
                await db.commit()
        await self._push_progress("", "stopped", 0, len(self._node_states))
        _stop_signals.pop(self.run_id, None)

    # ------------------------------------------------------------------
    # WS progress push
    # ------------------------------------------------------------------

    async def _push_progress(self, node_id: str, status: str, current: int, total: int) -> None:
        frame = {
            "type": "action.progress",
            "payload": {
                "run_id": self.run_id,
                "node_id": node_id,
                "node_status": status,
                "overall_progress": current / total if total else 0,
                "current": current,
                "total": total,
            }
        }
        await manager.send_to_user("user", frame)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _get_run(self, db: AsyncSession) -> Optional[ActionRun]:
        result = await db.execute(select(ActionRun).where(ActionRun.id == self.run_id))
        return result.scalar_one_or_none()

    async def _get_action(self, db: AsyncSession, action_id: str) -> Optional[Action]:
        result = await db.execute(select(Action).where(Action.id == action_id))
        return result.scalar_one_or_none()

    def _set_node_status(self, idx: int, status: str, output: str = "") -> None:
        if 0 <= idx < len(self._node_states):
            self._node_states[idx]["status"] = status
            if output:
                self._node_states[idx]["output"] = output

    def _log(self, text: str) -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        self._logs.append(f"[{ts}] {text}")

    def _engine_state(self) -> dict:
        from ..main import _app_state
        return _app_state


# ------------------------------------------------------------------
# Public launcher
# ------------------------------------------------------------------
async def _run_workflow_safely(engine: WorkflowEngine) -> None:
    try:
        await engine.execute()
    except Exception:
        logger.exception("Workflow %s failed", engine.run_id)


async def launch_workflow(run_id: str) -> None:
    """Fire-and-forget workflow execution."""
    engine = WorkflowEngine(run_id=run_id)
    asyncio.create_task(_run_workflow_safely(engine))
