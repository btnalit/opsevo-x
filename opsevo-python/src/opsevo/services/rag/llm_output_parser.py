"""LLM output parser — extracts structured data from LLM responses.

Requirements: 10.9
"""
from __future__ import annotations
import json, re
from typing import Any

def parse_json_from_llm(text: str) -> dict[str, Any] | None:
    match = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None

def extract_code_blocks(text: str) -> list[str]:
    return re.findall(r"```(?:\w+)?\s*(.*?)```", text, re.DOTALL)
