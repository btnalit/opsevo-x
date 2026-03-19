"""ReAct final answer extraction.

Requirements: 10.2
"""

from __future__ import annotations

import re


def extract_final_answer(text: str) -> str:
    match = re.search(r"Final Answer:\s*(.*)", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()
