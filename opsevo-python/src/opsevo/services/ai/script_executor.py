"""Script execution service.

Requirements: 11.4
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ScriptExecutorService:
    """Executes scripts on devices via the driver interface."""

    async def execute(self, driver: DeviceDriver, script: str, language: str = "") -> dict[str, Any]:
        start = time.monotonic()
        try:
            result = await driver.execute("run_script", {"script": script, "language": language})
            elapsed = (time.monotonic() - start) * 1000
            return {
                "success": result.success,
                "output": result.data if isinstance(result.data, str) else str(result.data or ""),
                "error": result.error,
                "executionTimeMs": elapsed,
            }
        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            logger.error("script_execution_failed", error=str(exc))
            return {"success": False, "output": "", "error": str(exc), "executionTimeMs": elapsed}

    async def validate(self, script: str, language: str = "") -> dict[str, Any]:
        """Basic syntax validation (placeholder — real validation depends on language)."""
        if not script.strip():
            return {"valid": False, "errors": ["Empty script"]}
        return {"valid": True, "errors": []}
