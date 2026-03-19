"""ParallelExecutionMetrics — tracks parallel execution statistics.

Requirements: 10.8
"""

from __future__ import annotations

import time
from typing import Any


class ParallelExecutionMetrics:
    def __init__(self) -> None:
        self._total_batches: int = 0
        self._total_actions: int = 0
        self._total_failures: int = 0
        self._total_time_ms: float = 0.0

    def record(self, batch_size: int, failures: int, elapsed_ms: float) -> None:
        self._total_batches += 1
        self._total_actions += batch_size
        self._total_failures += failures
        self._total_time_ms += elapsed_ms

    def get_stats(self) -> dict[str, Any]:
        return {
            "totalBatches": self._total_batches,
            "totalActions": self._total_actions,
            "totalFailures": self._total_failures,
            "avgBatchTimeMs": round(self._total_time_ms / max(self._total_batches, 1), 1),
            "successRate": round(
                (self._total_actions - self._total_failures) / max(self._total_actions, 1), 4
            ),
        }

    def reset(self) -> None:
        self._total_batches = 0
        self._total_actions = 0
        self._total_failures = 0
        self._total_time_ms = 0.0
