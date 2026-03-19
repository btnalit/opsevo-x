"""ReAct knowledge integration helpers.

Requirements: 10.2
"""

from __future__ import annotations

from typing import Any


def format_knowledge_for_react(entries: list[dict[str, Any]], max_entries: int = 5) -> str:
    if not entries:
        return ""
    parts = ["Relevant knowledge:"]
    for entry in entries[:max_entries]:
        content = entry.get("content", "")[:500]
        score = entry.get("score", 0)
        parts.append(f"- [{score:.2f}] {content}")
    return "\n".join(parts)
