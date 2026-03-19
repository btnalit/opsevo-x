"""KnowledgeSummarizer — condenses knowledge entries for prompt context.

Requirements: 11.5
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.tokens import count_tokens, truncate_to_tokens


class KnowledgeSummarizer:
    def __init__(self, max_tokens: int = 2000):
        self._max_tokens = max_tokens

    def summarize(self, entries: list[dict[str, Any]]) -> str:
        parts: list[str] = []
        budget = self._max_tokens
        for entry in entries:
            text = entry.get("content", "")
            tokens = count_tokens(text)
            if tokens <= budget:
                parts.append(text)
                budget -= tokens
            else:
                parts.append(truncate_to_tokens(text, budget))
                break
        return "\n---\n".join(parts)
