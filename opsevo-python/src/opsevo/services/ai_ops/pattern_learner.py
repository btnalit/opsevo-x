"""PatternLearner — learn patterns from historical alerts.

Requirements: 9.5
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class PatternLearner:
    def __init__(self) -> None:
        self._patterns: Counter[str] = Counter()

    def learn(self, events: list[dict[str, Any]]) -> None:
        for e in events:
            key = f"{e.get('severity','')}-{e.get('type','')}"
            self._patterns[key] += 1

    def get_top_patterns(self, n: int = 10) -> list[tuple[str, int]]:
        return self._patterns.most_common(n)

    def predict_next(self, recent: list[dict[str, Any]]) -> str | None:
        if not recent:
            return None
        last_key = f"{recent[-1].get('severity','')}-{recent[-1].get('type','')}"
        return last_key if self._patterns.get(last_key, 0) > 2 else None
