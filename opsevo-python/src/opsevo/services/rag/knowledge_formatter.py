"""Knowledge formatter — formats knowledge entries for prompt injection.

Requirements: 10.9
"""
from __future__ import annotations
from typing import Any

def format_entries(entries: list[dict[str, Any]], max_chars: int = 3000) -> str:
    parts, used = [], 0
    for e in entries:
        content = e.get("content", "")
        if used + len(content) > max_chars:
            remaining = max_chars - used
            if remaining > 100:
                parts.append(content[:remaining] + "...")
            break
        parts.append(content)
        used += len(content)
    return "\n---\n".join(parts)
