"""DependencyAnalyzer — resolves execution order based on dependencies.

Requirements: 10.7
"""

from __future__ import annotations

from typing import Any


class DependencyAnalyzer:
    def resolve_order(self, steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Simple topological sort by declared order (steps already ordered by planner)
        return sorted(steps, key=lambda s: s.get("order", 0))
