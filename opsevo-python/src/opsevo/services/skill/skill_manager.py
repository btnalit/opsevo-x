"""
SkillManager — 技能管理核心

管理技能的注册、查找、启用/禁用。
"""

from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class SkillManager:
    """技能管理器，管理所有已注册技能的生命周期。"""

    def __init__(self, datastore: Any = None) -> None:
        self._datastore = datastore
        self._skills: dict[str, dict[str, Any]] = {}
        self._enabled: set[str] = set()

    def register(self, name: str, definition: dict[str, Any]) -> None:
        self._skills[name] = definition
        self._enabled.add(name)
        logger.info("Skill registered", name=name)

    def unregister(self, name: str) -> None:
        self._skills.pop(name, None)
        self._enabled.discard(name)

    def get(self, name: str) -> dict[str, Any] | None:
        return self._skills.get(name)

    def list_all(self) -> list[dict[str, Any]]:
        return [
            {**defn, "name": name, "enabled": name in self._enabled}
            for name, defn in self._skills.items()
        ]

    def list_enabled(self) -> list[str]:
        return [n for n in self._skills if n in self._enabled]

    def enable(self, name: str) -> bool:
        if name in self._skills:
            self._enabled.add(name)
            return True
        return False

    def disable(self, name: str) -> bool:
        self._enabled.discard(name)
        return True

    def is_enabled(self, name: str) -> bool:
        return name in self._enabled
