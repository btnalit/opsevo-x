"""ActionSelector — maps intents to concrete tool actions.

Requirements: 10.7
"""

from __future__ import annotations

from typing import Any

_INTENT_ACTIONS: dict[str, list[dict[str, Any]]] = {
    "query": [{"tool": "query_device", "params": {}, "description": "Query device data"}],
    "configure": [{"tool": "configure", "params": {}, "description": "Apply configuration"}],
    "diagnose": [
        {"tool": "health_check", "params": {}, "description": "Check device health"},
        {"tool": "collect_metrics", "params": {}, "description": "Collect metrics"},
    ],
    "monitor": [{"tool": "collect_metrics", "params": {}, "description": "Collect metrics"}],
    "execute": [{"tool": "execute_command", "params": {}, "description": "Execute command"}],
}


class ActionSelector:
    def select(self, intent: str, query: str, context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        actions = _INTENT_ACTIONS.get(intent, _INTENT_ACTIONS["query"])
        return [dict(a) for a in actions]
