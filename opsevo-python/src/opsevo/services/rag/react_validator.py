"""ReAct output validation.

Requirements: 10.2
"""

from __future__ import annotations

from typing import Any


class ReactValidator:
    def validate_action(self, action: str, available_tools: list[str]) -> bool:
        return action in available_tools

    def validate_output(self, output: dict[str, Any]) -> tuple[bool, str]:
        if not output.get("answer"):
            return False, "No final answer produced"
        if output.get("iterations", 0) >= 10:
            return False, "Max iterations reached without resolution"
        return True, ""
