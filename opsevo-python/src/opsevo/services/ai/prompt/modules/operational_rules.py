"""Operational rules prompt module."""
from __future__ import annotations
from typing import Any

name = "operational_rules"

def render(context: dict[str, Any]) -> str:
    rules = context.get("operational_rules", [])
    if not rules:
        return ""
    lines = ["OPERATIONAL RULES:"]
    for r in rules:
        lines.append(f"- {r}")
    return "\n".join(lines)
