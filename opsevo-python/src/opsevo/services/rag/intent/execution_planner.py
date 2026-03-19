"""ExecutionPlanner — builds execution plans from selected actions.

Requirements: 10.7
"""

from __future__ import annotations

from typing import Any


class ExecutionPlanner:
    def plan(self, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        plan = []
        for i, action in enumerate(actions):
            plan.append({
                "order": i,
                "tool": action.get("tool", ""),
                "params": action.get("params", {}),
                "required": action.get("required", True),
                "description": action.get("description", ""),
            })
        return plan
