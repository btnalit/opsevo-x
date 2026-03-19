"""Usage tracker — tracks RAG usage statistics.

Requirements: 10.9
"""
from __future__ import annotations
from typing import Any

class UsageTracker:
    def __init__(self) -> None:
        self._queries = 0
        self._retrievals = 0
        self._tool_calls = 0

    def track_query(self) -> None:
        self._queries += 1
    def track_retrieval(self) -> None:
        self._retrievals += 1
    def track_tool_call(self) -> None:
        self._tool_calls += 1

    def get_stats(self) -> dict[str, int]:
        return {"queries": self._queries, "retrievals": self._retrievals, "toolCalls": self._tool_calls}

    def reset(self) -> None:
        self._queries = self._retrievals = self._tool_calls = 0
