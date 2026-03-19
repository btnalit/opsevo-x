"""JSON schema prompt module."""
from __future__ import annotations
from typing import Any

name = "json_schema"

def render(context: dict[str, Any]) -> str:
    return (
        "When returning structured data, use valid JSON format. "
        "Wrap JSON in ```json code blocks for clarity."
    )
