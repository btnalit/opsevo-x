"""ReAct parallel action execution.

Requirements: 10.2
"""

from __future__ import annotations

import asyncio
from typing import Any

from opsevo.services.rag.react_tools import ReactToolExecutor
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


async def execute_parallel_actions(
    executor: ReactToolExecutor,
    actions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    tasks = [executor.execute(a["tool"], a.get("input", {})) for a in actions]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    output = []
    for action, result in zip(actions, results):
        if isinstance(result, Exception):
            output.append({"tool": action["tool"], "success": False, "error": str(result)})
        else:
            output.append({"tool": action["tool"], **result})
    return output
