"""ReAct failure handling.

Requirements: 10.2
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ReactFailureHandler:
    def handle_tool_failure(self, tool: str, error: str, iteration: int) -> dict[str, Any]:
        logger.warning("react_tool_failure", tool=tool, error=error, iteration=iteration)
        return {
            "retry": iteration < 3,
            "fallback_message": f"Tool '{tool}' failed: {error}. Trying alternative approach.",
        }

    def handle_loop_timeout(self, iterations: int, tool_calls: list[dict]) -> dict[str, Any]:
        return {
            "answer": f"Analysis incomplete after {iterations} iterations. Partial results available.",
            "tool_calls": tool_calls,
            "timeout": True,
        }
