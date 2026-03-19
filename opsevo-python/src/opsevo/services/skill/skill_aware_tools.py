"""SkillAwareTools — 技能感知的工具注入。"""

from __future__ import annotations
from typing import Any


class SkillAwareTools:
    """根据激活的技能动态注入工具定义。"""

    def __init__(self, skill_factory: Any = None, base_tools: list[dict] | None = None) -> None:
        self._factory = skill_factory
        self._base_tools = base_tools or []

    def get_tools(self, skill_name: str | None = None) -> list[dict[str, Any]]:
        tools = list(self._base_tools)
        if skill_name and self._factory:
            try:
                instance = self._factory.get_skill(skill_name)
                tools.extend(instance.tools)
            except Exception:
                pass
        return tools

    def merge_tools(self, existing: list[dict], skill_name: str | None = None) -> list[dict]:
        if not skill_name:
            return existing
        skill_tools = self.get_tools(skill_name)
        existing_names = {t.get("name") for t in existing}
        for t in skill_tools:
            if t.get("name") not in existing_names:
                existing.append(t)
        return existing
