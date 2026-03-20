"""BootstrapSkillSystem — 技能系统初始化。"""

from __future__ import annotations
from pathlib import Path
from typing import Any
import structlog

from .skill_loader import SkillLoader
from .skill_manager import SkillManager

logger = structlog.get_logger(__name__)

# Fallback paths to search for builtin skills when primary path is empty.
# Docker image ships skills at /app/skills-backup; source tree has them at
# opsevo-python/data/ai-ops/skills.  Checking multiple locations makes
# skill loading resilient to entrypoint failures or volume-mount issues.
_FALLBACK_SKILL_DIRS = [
    "/app/skills-backup",                       # Docker image backup
    "opsevo-python/data/ai-ops/skills",         # Development source tree
]


class BootstrapSkillSystem:
    """初始化技能系统：加载内置技能并注册。"""

    def __init__(self, skill_manager: SkillManager, skills_dir: str = "data/ai-ops/skills") -> None:
        self._manager = skill_manager
        self._loader = SkillLoader(skills_dir)
        self._skills_dir = skills_dir

    async def bootstrap(self) -> int:
        definitions = self._loader.load_all()

        # Fallback: if primary path yielded nothing, try known backup locations
        if not definitions:
            for fallback in _FALLBACK_SKILL_DIRS:
                if Path(fallback).exists():
                    logger.info("skill_primary_empty_trying_fallback", primary=self._skills_dir, fallback=fallback)
                    fallback_loader = SkillLoader(fallback)
                    definitions = fallback_loader.load_all()
                    if definitions:
                        break

        count = 0
        for name, defn in definitions.items():
            self._manager.register(name, defn)
            count += 1
        logger.info("Skill system bootstrapped", skills_loaded=count)
        return count
