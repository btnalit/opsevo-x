"""SkillAwareReact — 技能感知的 ReAct 循环增强。"""

from __future__ import annotations
from typing import Any


class SkillAwareReact:
    """根据激活的技能调整 ReAct 循环行为。"""

    def __init__(self, skill_factory: Any = None) -> None:
        self._factory = skill_factory

    def get_react_config(self, skill_name: str | None = None) -> dict[str, Any]:
        if not skill_name or not self._factory:
            return {}
        try:
            instance = self._factory.get_skill(skill_name)
            defn = instance.definition
            return {
                "max_iterations": defn.get("react_max_iterations", 10),
                "allowed_tools": defn.get("react_allowed_tools", []),
                "forbidden_tools": defn.get("react_forbidden_tools", []),
                "temperature": defn.get("react_temperature", 0.3),
            }
        except Exception:
            return {}

    def filter_tools(self, tools: list[dict], skill_name: str | None = None) -> list[dict]:
        config = self.get_react_config(skill_name)
        allowed = set(config.get("allowed_tools", []))
        forbidden = set(config.get("forbidden_tools", []))
        if allowed:
            return [t for t in tools if t.get("name") in allowed]
        if forbidden:
            return [t for t in tools if t.get("name") not in forbidden]
        return tools
