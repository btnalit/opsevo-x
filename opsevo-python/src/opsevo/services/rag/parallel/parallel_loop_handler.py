"""ParallelLoopHandler — handles parallel actions within ReAct loop.

Requirements: 10.8
"""

from __future__ import annotations

from typing import Any

from opsevo.services.rag.parallel.parallel_executor import ParallelExecutor


class ParallelLoopHandler:
    def __init__(self, executor: ParallelExecutor):
        self._executor = executor

    async def handle(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        results = await self._executor.execute_batch(actions)
        success_count = sum(1 for r in results if r.get("success"))
        return {
            "results": results,
            "total": len(actions),
            "succeeded": success_count,
            "failed": len(actions) - success_count,
        }
