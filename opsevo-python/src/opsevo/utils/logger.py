"""Structured logging configuration using structlog.

Production environments get JSON output; development gets coloured console
output.  Call ``setup_logging(settings)`` once at startup, then use
``get_logger(name)`` anywhere to obtain a bound logger.

Requirements: 20.1
"""

from __future__ import annotations

import logging
import sys
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from opsevo.settings import Settings

_LOG_LEVEL_MAP: dict[str, int] = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}


def setup_logging(settings: Settings) -> None:
    """Configure structlog and stdlib logging based on *settings*.

    * **Production** (``settings.env == "production"``): JSON renderer.
    * **Development / other**: coloured console renderer.
    """
    level = _LOG_LEVEL_MAP.get(settings.log_level, logging.INFO)

    # Shared pre-chain processors (used by both structlog and stdlib)
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
    ]

    if settings.is_production:
        renderer: structlog.types.Processor = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a structlog bound logger for *name*."""
    return structlog.get_logger(name)
