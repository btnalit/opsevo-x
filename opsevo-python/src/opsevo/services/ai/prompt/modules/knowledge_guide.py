"""Knowledge guide prompt module."""
from __future__ import annotations
from typing import Any

name = "knowledge_guide"

def render(context: dict[str, Any]) -> str:
    knowledge = context.get("knowledge_context", "")
    if not knowledge:
        return ""
    return f"RELEVANT KNOWLEDGE:\n{knowledge}"
