"""IterationLoop — critic-reflector iteration for quality improvement.

Requirements: 9.3, 9.4
"""

from __future__ import annotations

from typing import Any

from opsevo.services.ai_ops.critic_service import CriticService
from opsevo.services.ai_ops.reflector_service import ReflectorService
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class IterationLoop:
    def __init__(self, critic: CriticService, reflector: ReflectorService, max_iterations: int = 3):
        self._critic = critic
        self._reflector = reflector
        self._max_iterations = max_iterations

    async def run(self, initial_decision: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        current = initial_decision
        for i in range(self._max_iterations):
            evaluation = await self._critic.evaluate(current, context)
            quality = evaluation.get("quality", 0)
            if quality >= 0.8:
                return {"decision": current, "iterations": i + 1, "quality": quality}
            reflection = await self._reflector.reflect([{**current, "evaluation": evaluation}])
            current = {**current, "refined": True, "iteration": i + 1, "reflection": reflection}
        return {"decision": current, "iterations": self._max_iterations, "quality": evaluation.get("quality", 0)}
