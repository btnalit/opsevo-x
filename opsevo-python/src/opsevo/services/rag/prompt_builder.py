"""PromptBuilder — build knowledge-enhanced prompts for LLM.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class PromptOptions:
    include_citations: bool = True
    include_credibility: bool = True
    max_knowledge_items: int = 10
    max_knowledge_chars: int = 4000


@dataclass
class FewShotOptions:
    enabled: bool = False
    max_examples: int = 3
    min_similarity: float = 0.6


class PromptBuilder:
    def __init__(self, options: PromptOptions | None = None, few_shot: FewShotOptions | None = None):
        self._options = options or PromptOptions()
        self._few_shot = few_shot or FewShotOptions()

    def build_knowledge_enhanced_prompt(
        self,
        system_prompt: str,
        message: str,
        knowledge: list[dict[str, Any]],
        device_info: str = "",
    ) -> str:
        parts: list[str] = [system_prompt]
        if device_info:
            parts.append(f"\n## Device Context\n{device_info}")
        if knowledge:
            formatted = self.format_knowledge_context(knowledge)
            parts.append(f"\n## Knowledge Context\n{formatted}")
            if self._options.include_citations:
                parts.append(f"\n{self.build_citation_guide()}")
        parts.append(f"\n## User Query\n{message}")
        return "\n".join(parts)

    def build_correction_prompt(
        self,
        original_response: str,
        issues: list[str],
        knowledge: list[dict[str, Any]],
    ) -> str:
        parts = [
            "The previous response had issues that need correction:",
            "\n".join(f"- {issue}" for issue in issues),
            f"\nOriginal response:\n{original_response}",
        ]
        if knowledge:
            parts.append(f"\nAvailable knowledge:\n{self.format_knowledge_context(knowledge)}")
        parts.append("\nPlease provide a corrected response addressing all issues.")
        return "\n".join(parts)

    def format_knowledge_context(self, knowledge: list[dict[str, Any]]) -> str:
        items = knowledge[: self._options.max_knowledge_items]
        lines: list[str] = []
        total_chars = 0
        for i, k in enumerate(items, 1):
            content = k.get("content", "")
            source = k.get("source", "unknown")
            credibility = k.get("credibility", "medium")
            entry = f"[{i}] ({source}"
            if self._options.include_credibility:
                entry += f", credibility: {self._credibility_label(credibility)}"
            entry += f")\n{content}"
            if total_chars + len(entry) > self._options.max_knowledge_chars:
                remaining = self._options.max_knowledge_chars - total_chars
                if remaining > 100:
                    lines.append(entry[:remaining] + "...")
                break
            lines.append(entry)
            total_chars += len(entry)
        return "\n\n".join(lines)

    def build_knowledge_summary(self, knowledge: list[dict[str, Any]]) -> str:
        if not knowledge:
            return "No relevant knowledge found."
        lines = [f"Found {len(knowledge)} relevant knowledge entries:"]
        for i, k in enumerate(knowledge[:5], 1):
            title = k.get("title", k.get("source", "untitled"))
            lines.append(f"  {i}. {title}")
        return "\n".join(lines)

    @staticmethod
    def build_citation_guide() -> str:
        return (
            "## Citation Guidelines\n"
            "When using knowledge from the context above, cite sources using [N] notation "
            "where N is the reference number. Prioritize higher credibility sources."
        )

    @staticmethod
    def _credibility_label(level: str) -> str:
        return {"high": "High", "medium": "Medium", "low": "Low"}.get(level, level)

    def build_knowledge_enhanced_prompt_with_experiences(
        self,
        system_prompt: str,
        message: str,
        knowledge: list[dict[str, Any]],
        experiences: list[dict[str, Any]],
        device_info: str = "",
    ) -> str:
        base = self.build_knowledge_enhanced_prompt(system_prompt, message, knowledge, device_info)
        if experiences:
            exp_text = self.format_few_shot_experiences(experiences)
            return base.replace("## User Query", f"## Past Experiences\n{exp_text}\n\n## User Query")
        return base

    def format_few_shot_experiences(self, experiences: list[dict[str, Any]]) -> str:
        items = experiences[: self._few_shot.max_examples]
        lines: list[str] = []
        for i, exp in enumerate(items, 1):
            query = exp.get("query", "")
            response = exp.get("response", "")
            lines.append(f"Example {i}:\nQ: {query}\nA: {response}")
        return "\n\n".join(lines)

    @staticmethod
    def get_experience_reference_id(experience_id: str) -> str:
        return f"exp_{experience_id[:8]}"

    @staticmethod
    def build_experience_citation_guide() -> str:
        return (
            "When referencing past experiences, use [exp_N] notation. "
            "Past experiences provide proven solutions for similar scenarios."
        )
