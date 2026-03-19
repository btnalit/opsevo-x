"""ToolCorrectionMiddleware — auto-corrects common tool call mistakes.

Requirements: 10.9
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


async def tool_correction_middleware(
    context: dict[str, Any],
    next_fn: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    tool_call = context.get("tool_call", {})
    tool_name = tool_call.get("tool", "")

    # Auto-correct common misspellings
    corrections = {
        "query": "query_device",
        "exec": "execute_command",
        "metrics": "collect_metrics",
        "health": "health_check",
    }
    if tool_name in corrections:
        tool_call["tool"] = corrections[tool_name]
        logger.info("tool_corrected", original=tool_name, corrected=tool_call["tool"])

    return await next_fn(context)
