"""ParallelExecutor — runs multiple tool actions concurrently.

Requirements: 10.8
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from opsevo.services.rag.react_tools import ReactToolExecutor
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ParallelExecutor:
    def __init__(self, tool_executor: ReactToolExecutor, max_concurrency: int = 5):
        self._executor = tool_executor
        self._semaphore = asyncio.Semaphore(max_concurrency)

    async def execute_batch(self, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        start = time.monotonic()

        async def _run(action: dict) -> dict:
            async with self._semaphore:
                result = await self._executor.execute(action["tool"], action.get("params", {}))
                return {"tool": action["tool"], **result}

        tasks = [_run(a) for a in actions]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        elapsed = (time.monotonic() - start) * 1000

        output = []
        for action, result in zip(actions, results):
            if isinstance(result, Exception):
                output.append({"tool": action["tool"], "success": False, "error": str(result)})
            else:
                output.append(result)

        logger.info("parallel_batch_done", count=len(actions), elapsed_ms=round(elapsed, 1))
        return output
