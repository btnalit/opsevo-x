"""
SkillFactory — 技能实例工厂

根据技能定义创建可执行的技能实例。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import structlog

from .capsule_runner import CapsuleRunner

logger = structlog.get_logger(__name__)


class SkillInstance:
    """可执行的技能实例。"""

    def __init__(self, name: str, definition: dict[str, Any], context: dict[str, Any] | None = None) -> None:
        self.name = name
        self.definition = definition
        self._context = context or {}

        raw = definition.get("capsule_dir")
        self.capsule_dir: Path | None = Path(raw) if raw else None

    async def execute(self, input_data: dict[str, Any], device_id: str | None = None) -> dict[str, Any]:
        logger.info("Skill executing", name=self.name, device_id=device_id)

        # If no capsule_dir or directory doesn't exist, fall back to stub
        if self.capsule_dir is None or not self.capsule_dir.is_dir():
            return {"skill": self.name, "status": "executed", "input": input_data}

        # Build capsule input, include device_id when present
        capsule_input: dict[str, Any] = {**input_data}
        if device_id:
            capsule_input["device_id"] = device_id

        runtime = self.definition.get("runtime", "python")
        timeout = self.definition.get("timeout", 30.0)

        return await CapsuleRunner().run(
            capsule_dir=self.capsule_dir,
            input_data=capsule_input,
            runtime=runtime,
            timeout=timeout,
        )

    @property
    def tools(self) -> list[dict[str, Any]]:
        return self.definition.get("tools", [])

    @property
    def prompt_additions(self) -> str:
        return self.definition.get("system_prompt", "")


class SkillFactory:
    """根据技能定义创建技能实例。"""

    def __init__(self, skill_manager: Any = None) -> None:
        self._manager = skill_manager
        self._instances: dict[str, SkillInstance] = {}

    def get_skill(self, name: str) -> SkillInstance:
        if name in self._instances:
            return self._instances[name]
        defn = self._manager.get(name) if self._manager else None
        if not defn:
            raise ValueError(f"Skill not found: {name}")
        instance = SkillInstance(name=name, definition=defn)
        self._instances[name] = instance
        return instance

    def create(self, name: str, definition: dict[str, Any]) -> SkillInstance:
        instance = SkillInstance(name=name, definition=definition)
        self._instances[name] = instance
        return instance

    def clear_cache(self) -> None:
        self._instances.clear()
