"""FastPath intent classifier.
Requirements: 10.3
"""
from __future__ import annotations
from typing import Any

_FAST_INTENTS: dict[str, list[str]] = {
    "system_status": ["status", "uptime", "health", "resource"],
    "interface_list": ["interface", "port", "link"],
    "cpu_memory": ["cpu", "memory", "ram", "load"],
}

class FastPathIntentClassifier:
    def classify(self, query: str) -> str | None:
        q = query.lower()
        for intent, keywords in _FAST_INTENTS.items():
            if any(kw in q for kw in keywords):
                return intent
        return None
