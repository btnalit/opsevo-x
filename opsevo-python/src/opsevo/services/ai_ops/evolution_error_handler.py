"""EvolutionErrorHandler — handle errors during evolution processes.

Requirements: 9.7
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class EvolutionErrorHandler:
    def __init__(self) -> None:
        self._error_log: list[dict[str, Any]] = []
        self._max_log: int = 500

    def handle(self, error: Exception, context: dict[str, Any] | None = None) -> dict[str, Any]:
        entry = {"error": str(error), "type": type(error).__name__, "context": context or {}}
        self._error_log.append(entry)
        if len(self._error_log) > self._max_log:
            self._error_log = self._error_log[-self._max_log:]
        logger.error("evolution_error", error=str(error), context=context)
        return {"handled": True, "action": "logged"}

    def get_recent_errors(self, limit: int = 20) -> list[dict[str, Any]]:
        return self._error_log[-limit:]

    def get_error_stats(self) -> dict[str, int]:
        from collections import Counter
        types = Counter(e["type"] for e in self._error_log)
        return dict(types)
