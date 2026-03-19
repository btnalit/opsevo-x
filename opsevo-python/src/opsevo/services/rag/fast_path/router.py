"""FastPath router — routes fast-path intents to direct device queries.
Requirements: 10.3
"""
from __future__ import annotations
from typing import Any
from opsevo.drivers.base import DeviceDriver
from opsevo.services.rag.fast_path.intent_classifier import FastPathIntentClassifier
from opsevo.services.rag.fast_path.metrics import FastPathMetrics

_INTENT_TO_ACTION: dict[str, str] = {
    "system_status": "get_system_resource",
    "interface_list": "get_interfaces",
    "cpu_memory": "get_system_resource",
}

class FastPathRouter:
    def __init__(self) -> None:
        self._classifier = FastPathIntentClassifier()
        self._metrics = FastPathMetrics()

    async def try_fast_path(self, query: str, driver: DeviceDriver) -> dict[str, Any] | None:
        intent = self._classifier.classify(query)
        if not intent:
            self._metrics.record_miss()
            return None
        action = _INTENT_TO_ACTION.get(intent)
        if not action:
            self._metrics.record_miss()
            return None
        try:
            data = await driver.query(action)
            self._metrics.record_hit()
            return {"fast_path": True, "intent": intent, "data": data}
        except Exception:
            self._metrics.record_miss()
            return None

    def get_metrics(self) -> dict[str, Any]:
        return self._metrics.get_stats()
