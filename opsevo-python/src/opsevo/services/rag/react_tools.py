"""ReactToolExecutor — executes tools via DeviceDriver interface.

All device commands dispatched through DeviceDriver.query()/execute()
using action_type routing. No hardcoded API paths.

Requirements: 10.2, 1.8, 1.9
"""

from __future__ import annotations

from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ReactToolExecutor:
    """Executes ReAct tool calls through the DeviceDriver interface."""

    def __init__(self, driver: DeviceDriver):
        self._driver = driver

    async def execute(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            if tool_name == "query_device":
                action_type = params.get("action_type", "")
                data = await self._driver.query(action_type, params.get("query_params"))
                return {"success": True, "data": data}

            if tool_name == "execute_command":
                action_type = params.get("action_type", "")
                result = await self._driver.execute(action_type, params.get("payload"))
                return {"success": result.success, "data": result.data, "error": result.error}

            if tool_name == "collect_metrics":
                metrics = await self._driver.collect_metrics()
                return {"success": True, "data": metrics.model_dump()}

            if tool_name == "health_check":
                hc = await self._driver.health_check()
                return {"success": True, "data": hc.model_dump()}

            if tool_name == "collect_data":
                data_type = params.get("data_type", "")
                data = await self._driver.collect_data(data_type)
                return {"success": True, "data": data}

            if tool_name == "configure":
                action_type = params.get("action_type", "")
                result = await self._driver.configure(action_type, params.get("config", {}))
                return {"success": result.success, "data": result.data, "error": result.error}

            return {"success": False, "error": f"Unknown tool: {tool_name}"}

        except Exception as exc:
            logger.error("react_tool_error", tool=tool_name, error=str(exc))
            return {"success": False, "error": str(exc)}

    def get_available_tools(self) -> list[dict[str, str]]:
        manifest = self._driver.get_capability_manifest()
        tools = [
            {"name": "query_device", "description": "Query device data by action_type"},
            {"name": "execute_command", "description": "Execute a command on the device"},
            {"name": "collect_metrics", "description": "Collect device metrics"},
            {"name": "health_check", "description": "Check device health"},
            {"name": "collect_data", "description": "Collect specific data type from device"},
        ]
        if manifest.remediation_templates:
            tools.append({"name": "configure", "description": "Apply configuration changes"})
        return tools
