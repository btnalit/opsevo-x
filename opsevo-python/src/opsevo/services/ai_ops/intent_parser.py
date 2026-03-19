"""IntentParser — parse operational intents from events.

Requirements: 9.6
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class IntentParser:
    def __init__(self) -> None:
        self._patterns: dict[str, list[str]] = {
            "diagnose": ["error", "fail", "down", "unreachable", "timeout"],
            "optimize": ["slow", "high cpu", "high memory", "latency", "bottleneck"],
            "configure": ["config", "setup", "enable", "disable", "change"],
            "monitor": ["check", "status", "health", "metric", "uptime"],
        }

    def parse(self, text: str) -> dict[str, Any]:
        text_lower = text.lower()
        for intent, keywords in self._patterns.items():
            if any(kw in text_lower for kw in keywords):
                return {"intent": intent, "confidence": 0.7}
        return {"intent": "unknown", "confidence": 0.1}
