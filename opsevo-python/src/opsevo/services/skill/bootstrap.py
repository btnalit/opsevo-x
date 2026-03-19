"""BootstrapSkillSystem — 技能系统初始化。"""

from __future__ import annotations
from typing import Any
import structlog

from .skill_loader import SkillLoader
from .skill_manager import SkillManager

logger = structlog.get_logger(__name__)


class BootstrapSkillSystem:
    """初始化技能系统：加载内置技能并注册。"""

    def __init__(self, skill_manager: SkillManager, skills_dir: str = "data/ai-ops/skills") -> None:
        self._manager = skill_manager
        self._loader = SkillLoader(skills_dir)

    async def bootstrap(self) -> int:
        definitions = self._loader.load_all()
        count = 0
        for name, defn in definitions.items():
            self._manager.register(name, defn)
            count += 1
        logger.info("Skill system bootstrapped", skills_loaded=count)
        return count
