"""SkillAwarePrompt — 技能感知的 Prompt 增强。"""

from __future__ import annotations
from typing import Any


class SkillAwarePrompt:
    """根据激活的技能动态增强 system prompt。"""

    def __init__(self, skill_factory: Any = None) -> None:
        self._factory = skill_factory

    def enhance(self, base_prompt: str, skill_name: str | None = None) -> str:
        if not skill_name or not self._factory:
            return base_prompt
        try:
            instance = self._factory.get_skill(skill_name)
            additions = instance.prompt_additions
            if additions:
                return f"{base_prompt}\n\n## Active Skill: {skill_name}\n{additions}"
        except Exception:
            pass
        return base_prompt

    def get_skill_context(self, skill_name: str) -> str:
        if not self._factory:
            return ""
        try:
            instance = self._factory.get_skill(skill_name)
            return instance.prompt_additions
        except Exception:
            return ""
