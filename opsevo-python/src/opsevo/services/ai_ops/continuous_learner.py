"""ContinuousLearner — continuously learn from feedback and outcomes.

Requirements: 9.7
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ContinuousLearner:
    def __init__(self) -> None:
        self._experience_buffer: list[dict[str, Any]] = []
        self._max_buffer: int = 1000

    async def learn(self, event: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
        experience = {"event": event, "outcome": outcome}
        self._experience_buffer.append(experience)
        if len(self._experience_buffer) > self._max_buffer:
            self._experience_buffer = self._experience_buffer[-self._max_buffer:]
        return {"buffered": len(self._experience_buffer)}

    def get_experiences(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._experience_buffer[-limit:]
