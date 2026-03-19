"""Context builder — assembles device context for AI prompts.

Dynamically reads config_paths from CapabilityManifest instead of
hardcoded CONFIG_PATHS.

Requirements: 11.4, 1.3
"""

from __future__ import annotations

from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ContextBuilderService:
    """Builds device context for AI conversations."""

    async def build_context(self, driver: DeviceDriver) -> dict[str, Any]:
        manifest = driver.get_capability_manifest()
        context: dict[str, Any] = {
            "vendor": manifest.vendor,
            "model": manifest.model,
            "driver_type": manifest.driver_type,
            "capabilities": manifest.data_capabilities,
        }

        # Collect config sections from manifest.config_paths
        sections: dict[str, Any] = {}
        for action_type in manifest.config_paths:
            try:
                data = await driver.query(action_type)
                sections[action_type] = data
            except Exception as exc:
                logger.warning("context_section_failed", action_type=action_type, error=str(exc))
                sections[action_type] = {"error": str(exc)}

        context["sections"] = sections
        return context

    async def get_section(self, driver: DeviceDriver, section: str) -> Any:
        try:
            return await driver.query(section)
        except Exception as exc:
            return {"error": str(exc)}
