"""TokenBudgetManager — tracks and enforces token budgets.

Requirements: 11.5
"""

from __future__ import annotations

from opsevo.utils.logger import get_logger
from opsevo.utils.tokens import count_tokens

logger = get_logger(__name__)


class TokenBudgetManager:
    def __init__(self, daily_budget: int = 500000):
        self._daily_budget = daily_budget
        self._used: int = 0

    @property
    def remaining(self) -> int:
        return max(0, self._daily_budget - self._used)

    @property
    def used(self) -> int:
        return self._used

    def can_afford(self, estimated_tokens: int) -> bool:
        return self._used + estimated_tokens <= self._daily_budget

    def consume(self, tokens: int) -> None:
        self._used += tokens
        if self._used > self._daily_budget:
            logger.warning("token_budget_exceeded", used=self._used, budget=self._daily_budget)

    def reset(self) -> None:
        self._used = 0

    def estimate_message_tokens(self, messages: list[dict]) -> int:
        total = 0
        for m in messages:
            total += count_tokens(m.get("content", ""))
        return total
