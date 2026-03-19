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


class ToolOutputSummarizer:
    """Class-based wrapper around summarize_output for use in ResponseGenerator."""

    def __init__(self, max_chars_per_output: int = 2000):
        self._max_chars = max_chars_per_output

    def summarize(self, output: Any) -> str:
        return summarize_output(output, max_length=self._max_chars)
