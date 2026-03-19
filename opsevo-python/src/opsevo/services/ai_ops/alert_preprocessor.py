"""AlertPreprocessor — severity mapping from Profile config (device-agnostic).

Requirements: 9.1, 1.6
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AlertPreprocessor:
    """Severity mapping loaded from DeviceDriver Profile, zero hardcoded RouterOS mappings."""

    def __init__(self) -> None:
        self._severity_map: dict[str, str] = {}

    def load_severity_mapping(self, mapping: dict[str, list[str]]) -> None:
        self._severity_map.clear()
        for severity, topics in mapping.items():
            for topic in topics:
                self._severity_map[topic.lower()] = severity
        logger.info("preprocessor_severity_map_loaded", entries=len(self._severity_map))

    def map_severity(self, topic: str) -> str:
        return self._severity_map.get(topic.lower(), "info")

    def preprocess(self, event: dict[str, Any]) -> dict[str, Any]:
        topic = event.get("topic", "")
        if topic and not event.get("severity"):
            event["severity"] = self.map_severity(topic)
        return event
