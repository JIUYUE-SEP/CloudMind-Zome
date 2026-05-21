"""Structured JSON logging with API key redaction.

Design reference: §6.12 日志与可观测性
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone


class JSONFormatter(logging.Formatter):
    """Structured JSON log formatter.

    Design reference: §6.12.2
    """

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "session_id": getattr(record, "session_id", "-"),
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "func": record.funcName,
            "line": record.lineno,
        }

        # Add extra fields if present
        for key in ["provider", "model", "tokens_used", "tool_name", "duration_ms"]:
            if hasattr(record, key):
                log_entry[key] = getattr(record, key)

        return json.dumps(log_entry, ensure_ascii=False, default=str)


class RedactingFormatter(JSONFormatter):
    """JSON formatter that automatically redacts sensitive data.

    Design reference: §6.12.2
    """

    SENSITIVE_PATTERNS = [
        (r"(sk-[a-zA-Z0-9]{8})[a-zA-Z0-9]+", r"\1***"),
        (r'(api_key["\'\s:=]+)["\']?[a-zA-Z0-9]{8}[a-zA-Z0-9]+', r"\1***"),
        (r"(Bearer\s+)[a-zA-Z0-9\-._~+/]+=*", r"\1***"),
    ]

    def format(self, record: logging.LogRecord) -> str:
        result = super().format(record)
        for pattern, replacement in self.SENSITIVE_PATTERNS:
            result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)
        return result


def setup_logging(
    level: str = "INFO",
    log_dir: str | None = None,
) -> None:
    """Setup logging with JSON format and file handlers.

    Design reference: §6.12.3
    """
    from pathlib import Path

    logger = logging.getLogger("agenschedule")
    logger.setLevel(getattr(logging, level.upper()))

    # Remove existing handlers
    logger.handlers = []

    # Console handler
    console = logging.StreamHandler()
    console.setFormatter(RedactingFormatter())
    logger.addHandler(console)

    # File handlers
    if log_dir:
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)

        # Main log
        agent_handler = logging.FileHandler(log_path / "agent.log", encoding="utf-8")
        agent_handler.setFormatter(RedactingFormatter())
        agent_handler.setLevel(logging.INFO)
        logger.addHandler(agent_handler)

        # Error log
        error_handler = logging.FileHandler(log_path / "errors.log", encoding="utf-8")
        error_handler.setFormatter(RedactingFormatter())
        error_handler.setLevel(logging.WARNING)
        logger.addHandler(error_handler)
