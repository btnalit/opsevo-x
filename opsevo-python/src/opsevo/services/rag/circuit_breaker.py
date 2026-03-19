"""Circuit breaker for external service calls.

Requirements: 10.9
"""
from __future__ import annotations
import time

class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, reset_timeout: float = 60.0):
        self._threshold = failure_threshold
        self._timeout = reset_timeout
        self._failures = 0
        self._last_failure: float = 0
        self._state = "closed"  # closed | open | half_open

    @property
    def is_open(self) -> bool:
        if self._state == "open":
            if time.monotonic() - self._last_failure > self._timeout:
                self._state = "half_open"
                return False
            return True
        return False

    def record_success(self) -> None:
        self._failures = 0
        self._state = "closed"

    def record_failure(self) -> None:
        self._failures += 1
        self._last_failure = time.monotonic()
        if self._failures >= self._threshold:
            self._state = "open"

    @property
    def state(self) -> str:
        return self._state
