"""Communication dispatchers — callbacks injected by the platform layer.

These functions are registered at startup by app/main.py so the engine
can dispatch peer-to-peer messages and workflow progress without
importing platform code.
"""

from __future__ import annotations

from typing import Awaitable, Callable

# Will be injected by platform layer during startup
_send_private_message: Callable[[str, str, str], Awaitable[str]] | None = None
_report_workflow_progress: Callable[..., Awaitable[None]] | None = None


def register_comms_callbacks(
    send_private_message: Callable[[str, str, str], Awaitable[str]] | None = None,
    report_workflow_progress: Callable[..., Awaitable[None]] | None = None,
) -> None:
    """Register communication callbacks from the platform layer.

    Args:
        send_private_message: async fn(sender_id, target_id, content) -> reply_text
        report_workflow_progress: async fn(run_id, node_id, status, summary, sender_id)
    """
    global _send_private_message, _report_workflow_progress
    if send_private_message is not None:
        _send_private_message = send_private_message
    if report_workflow_progress is not None:
        _report_workflow_progress = report_workflow_progress


def get_send_private_message() -> Callable[[str, str, str], Awaitable[str]] | None:
    return _send_private_message


def get_report_workflow_progress() -> Callable[..., Awaitable[None]] | None:
    return _report_workflow_progress
