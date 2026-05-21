"""Commission scheduler: background task that polls commissions table
and dispatches Jobs to Agent Workers.

Design: one asyncio.Task started in FastAPI lifespan,
polls every 60 seconds, handles both cron and interval triggers.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models import Commission, CommissionLog, ChatSession, ChatSessionMember
from .job_queue import AgentJob
from .agent_worker import dispatch_job
from .event_bus import manager

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Scheduler task
# ------------------------------------------------------------------

class CommissionScheduler:
    """Polls active commissions and dispatches Jobs to Agent Workers."""

    def __init__(self, interval_seconds: float = 60.0):
        self.interval = interval_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("Commission scheduler started (interval=%ss)", self.interval)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("Commission scheduler stopped")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._tick()
            except Exception:
                logger.exception("Commission scheduler tick failed")
            await asyncio.sleep(self.interval)

    async def _tick(self) -> None:
        now = datetime.now(timezone.utc)
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Commission).where(
                    Commission.status == "active",
                    Commission.next_run_at <= now,
                )
            )
            commissions = result.scalars().all()

        for comm in commissions:
            try:
                await self._execute(comm)
            except Exception:
                logger.exception("Commission execution failed: %s", comm.id)

    # ------------------------------------------------------------------
    # Execute a single commission
    # ------------------------------------------------------------------

    async def _execute(self, comm: Commission) -> None:
        start = datetime.now(timezone.utc)
        logger.info("Executing commission %s for agent %s", comm.id, comm.agent_id)

        # Build instruction from action_config
        action_cfg = comm.action_config or {}
        instruction = action_cfg.get("instruction", "")
        if not instruction:
            instruction = f"请执行委托任务：{comm.name}"

        # Determine output target
        output_target = comm.output_target or "notification_center"

        # Dispatch to Agent Worker queue (fire-and-forget, log on completion)
        full_content = ""
        comm_id = comm.id
        comm_name = comm.name
        agent_id = comm.agent_id
        user_id = comm.user_id

        async def on_chunk(text: str) -> None:
            nonlocal full_content
            full_content += text

        async def on_done(text: str, ok: bool) -> None:
            # Save log after Job actually completes
            duration = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)
            try:
                async with AsyncSessionLocal() as db:
                    log = CommissionLog(
                        id=str(uuid.uuid4()),
                        commission_id=comm_id,
                        status="success" if ok else "failed",
                        result_summary=full_content[:1000],
                        duration_ms=duration,
                    )
                    db.add(log)

                    # Update commission next_run
                    result = await db.execute(
                        select(Commission).where(Commission.id == comm_id)
                    )
                    comm_row = result.scalar_one_or_none()
                    if comm_row:
                        next_run = self._calc_next_run(comm_row)
                        comm_row.next_run_at = next_run
                        comm_row.last_run_at = start
                        comm_row.last_run_id = log.id
                    await db.commit()
            except Exception:
                logger.exception("Commission post-execution save failed")

            # Notify user
            if output_target == "notification_center" and full_content:
                frame = {
                    "type": "notification.new",
                    "payload": {
                        "title": f"委托完成: {comm_name}",
                        "content": full_content[:200],
                        "commission_id": comm_id,
                        "agent_id": agent_id,
                    },
                }
                try:
                    await manager.send_to_user(user_id, frame)
                except Exception:
                    pass

        job = AgentJob(
            source="commission",
            source_id=comm_id,
            source_name=f"委托: {comm_name}",
            sender_name="委托系统",
            content=instruction,
            on_chunk=on_chunk,
            on_done=on_done,
        )
        await dispatch_job(agent_id, job)

    # ------------------------------------------------------------------
    # Next-run calculation
    # ------------------------------------------------------------------

    def _calc_next_run(self, comm: Commission) -> datetime | None:
        trigger_cfg = comm.trigger_config or {}
        trigger_type = comm.trigger_type

        if trigger_type == "interval":
            seconds = trigger_cfg.get("seconds", 3600)
            return datetime.now(timezone.utc) + timedelta(seconds=seconds)

        if trigger_type == "cron":
            expr = trigger_cfg.get("expression", "0 * * * *")
            try:
                from croniter import croniter
                base = datetime.now(timezone.utc)
                return croniter(expr, base).get_next(datetime)
            except ImportError:
                logger.warning("croniter not installed, falling back to hourly")
                return datetime.now(timezone.utc) + timedelta(hours=1)
            except Exception:
                logger.warning("Invalid cron expression '%s', fallback to 1h", expr)
                return datetime.now(timezone.utc) + timedelta(hours=1)

        # Manual / one-shot
        return None


# ------------------------------------------------------------------
# Singleton instance
# ------------------------------------------------------------------
_scheduler: CommissionScheduler | None = None


def get_scheduler() -> CommissionScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = CommissionScheduler()
    return _scheduler
