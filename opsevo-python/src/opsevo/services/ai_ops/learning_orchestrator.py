"""LearningOrchestrator — coordinate learning from operational data.

Requirements: 9.7
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class LearningOrchestrator:
    def __init__(self) -> None:
        self._learners: list[Any] = []

    def register_learner(self, learner: Any) -> None:
        self._learners.append(learner)

    async def learn_from_event(self, event: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        for learner in self._learners:
            try:
                if hasattr(learner, "learn"):
                    r = await learner.learn(event, outcome)
                    results.append(r)
            except Exception:
                pass
        return {"learners_invoked": len(self._learners), "results": results}
