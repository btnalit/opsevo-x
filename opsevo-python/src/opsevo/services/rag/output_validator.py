"""OutputValidator — validates LLM output knowledge citations.

Requirements: 10.10
"""
from __future__ import annotations
from typing import Any

class OutputValidator:
    def validate_citations(self, response: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
        source_ids = {str(s.get("id", "")) for s in sources}
        # Simple check: look for [source:xxx] patterns
        import re
        cited = set(re.findall(r"\[source:(\w+)\]", response))
        valid = cited & source_ids
        invalid = cited - source_ids
        return {"valid_citations": list(valid), "invalid_citations": list(invalid), "uncited_sources": list(source_ids - cited)}

    def build_correction_prompt(self, validation: dict[str, Any]) -> str:
        if not validation.get("invalid_citations"):
            return ""
        return f"Please correct these invalid citations: {validation['invalid_citations']}"
