"""Tool output summarizer — condenses verbose tool outputs.

Requirements: 10.9
"""
from __future__ import annotations
import json
from typing import Any

def summarize_output(output: Any, max_length: int = 2000) -> str:
    if isinstance(output, str):
        return output[:max_length] + ("..." if len(output) > max_length else "")
    text = json.dumps(output, ensure_ascii=False, default=str)
    return text[:max_length] + ("..." if len(text) > max_length else "")
