"""IntentDrivenExecutor — orchestrates intent-based execution plans.

Requirements: 10.7
"""

from __future__ import annotations

from typing import Any

from opsevo.services.rag.intent.action_selector import ActionSelector
from opsevo.services.rag.intent.dependency_analyzer import DependencyAnalyzer
from opsevo.services.rag.intent.execution_planner import ExecutionPlanner
from opsevo.services.rag.intent.intent_analyzer import IntentAnalyzer
from opsevo.services.rag.react_tools import ReactToolExecutor
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class IntentDrivenExecutor:
    def __init__(self, tool_executor: ReactToolExecutor):
        self._analyzer = IntentAnalyzer()
        self._planner = ExecutionPlanner()
        self._deps = DependencyAnalyzer()
        self._selector = ActionSelector()
        self._executor = tool_executor

    async def execute(self, query: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        intent = self._analyzer.analyze(query)
        logger.info("intent_analyzed", intent=intent["intent"], confidence=intent["confidence"])

        actions = self._selector.select(intent["intent"], query, context)
        plan = self._planner.plan(actions)
        ordered = self._deps.resolve_order(plan)

        results: list[dict] = []
        for step in ordered:
            result = await self._executor.execute(step["tool"], step.get("params", {}))
            results.append({"step": step, "result": result})
            if not result.get("success") and step.get("required", True):
                break

        return {"intent": intent, "plan": plan, "results": results}
