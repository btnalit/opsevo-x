"""SkillRegistry — 技能注册表，集中管理技能元数据。"""

from __future__ import annotations
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class SkillRegistry:
    """技能注册表。"""

    def __init__(self) -> None:
        self._registry: dict[str, dict[str, Any]] = {}

    def register(self, name: str, metadata: dict[str, Any]) -> None:
        self._registry[name] = metadata

    def get(self, name: str) -> dict[str, Any] | None:
        return self._registry.get(name)

    def list_names(self) -> list[str]:
        return list(self._registry.keys())

    def list_all(self) -> list[dict[str, Any]]:
        return [{"name": k, **v} for k, v in self._registry.items()]

    def remove(self, name: str) -> None:
        self._registry.pop(name, None)
