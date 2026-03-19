"""FaultPatternLibrary — known fault pattern matching.

Requirements: 9.2
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class FaultPattern:
    id: str = ""
    name: str = ""
    keywords: list[str] = field(default_factory=list)
    severity: str = "warning"
    category: str = "unknown"
    remediation_hint: str = ""


class FaultPatternLibrary:
    def __init__(self) -> None:
        self._patterns: list[FaultPattern] = []

    def load_patterns(self, patterns: list[dict[str, Any]]) -> None:
        self._patterns = [FaultPattern(**p) for p in patterns]
        logger.info("fault_patterns_loaded", count=len(self._patterns))

    def match(self, message: str) -> FaultPattern | None:
        msg_lower = message.lower()
        for p in self._patterns:
            if any(kw.lower() in msg_lower for kw in p.keywords):
                return p
        return None

    def get_all(self) -> list[FaultPattern]:
        return list(self._patterns)
