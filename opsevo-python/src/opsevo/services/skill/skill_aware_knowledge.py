"""SkillAwareKnowledge — 技能感知的知识检索增强。"""

from __future__ import annotations
from typing import Any


class SkillAwareKnowledge:
    """根据激活的技能调整知识检索策略。"""

    def __init__(self, skill_factory: Any = None) -> None:
        self._factory = skill_factory

    def get_knowledge_filter(self, skill_name: str | None = None) -> dict[str, Any]:
        if not skill_name or not self._factory:
            return {}
        try:
            instance = self._factory.get_skill(skill_name)
            defn = instance.definition
            return {
                "categories": defn.get("knowledge_categories", []),
                "boost_tags": defn.get("knowledge_boost_tags", []),
                "min_relevance": defn.get("knowledge_min_relevance", 0.3),
            }
        except Exception:
            return {}

    def enhance_query(self, query: str, skill_name: str | None = None) -> str:
        if not skill_name or not self._factory:
            return query
        try:
            instance = self._factory.get_skill(skill_name)
            prefix = instance.definition.get("query_prefix", "")
            return f"{prefix} {query}" if prefix else query
        except Exception:
            return query
