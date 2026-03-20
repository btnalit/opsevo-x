"""
FeatureFlagManager — 功能开关管理

控制状态机流程中各功能的启用/禁用。
"""

from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class FeatureFlagManager:
    """管理功能开关，控制流程行为。"""

    def __init__(self, datastore: Any = None) -> None:
        self._datastore = datastore
        self._flags: dict[str, bool] = {}
        self._defaults: dict[str, bool] = {
            "fast_path_enabled": True,
            "intent_driven_enabled": True,
            "parallel_execution_enabled": True,
            "auto_remediation_enabled": True,
            "brain_autonomous_enabled": True,
        }

    async def load(self) -> None:
        if self._datastore:
            try:
                rows = await self._datastore.query("SELECT key, value FROM feature_flags")
                for row in rows:
                    self._flags[row["key"]] = row["value"] == "true"
            except Exception:
                logger.warning("Failed to load feature flags from DB, using defaults")
        self._flags = {**self._defaults, **self._flags}

    def is_enabled(self, flag: str) -> bool:
        return self._flags.get(flag, self._defaults.get(flag, False))

    async def set_flag(self, flag: str, enabled: bool) -> None:
        self._flags[flag] = enabled
        if self._datastore:
            try:
                await self._datastore.execute(
                    "INSERT INTO feature_flags (key, value) VALUES ($1, $2) "
                    "ON CONFLICT (key) DO UPDATE SET value = $2",
                    [flag, "true" if enabled else "false"],
                )
            except Exception:
                logger.warning("Failed to persist feature flag", flag=flag)

    def get_all(self) -> dict[str, bool]:
        return dict(self._flags)
