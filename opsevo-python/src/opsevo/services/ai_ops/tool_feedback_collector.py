"""ToolFeedbackCollector — collect tool execution metrics and stats.

Requirements: 9.9
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ToolFeedbackCollector:
    def __init__(self) -> None:
        self._executions: list[dict[str, Any]] = []
        self._tool_stats: Counter[str] = Counter()
        self._success_stats: Counter[str] = Counter()
        self._max_history: int = 5000

    def record(self, tool_name: str, success: bool, duration_ms: int, metadata: dict[str, Any] | None = None) -> None:
        self._executions.append({
            "tool": tool_name, "success": success, "duration_ms": duration_ms,
            "timestamp": int(time.time() * 1000), **(metadata or {}),
        })
        self._tool_stats[tool_name] += 1
        if success:
            self._success_stats[tool_name] += 1
        if len(self._executions) > self._max_history:
            self._executions = self._executions[-self._max_history:]

    def get_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}
        for tool, total in self._tool_stats.items():
            success = self._success_stats.get(tool, 0)
            stats[tool] = {"total": total, "success": success, "rate": round(success / max(total, 1), 2)}
        return stats

    def get_recent(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._executions[-limit:]
