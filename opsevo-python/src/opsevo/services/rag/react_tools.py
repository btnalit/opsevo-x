"""ReactToolExecutor — executes tools via DeviceDriver interface.

All device commands dispatched through DeviceDriver.query()/execute()
using action_type routing. No hardcoded API paths.

Requirements: 10.2, 1.8, 1.9, 3.4, 3.9, 3.10
"""

from __future__ import annotations

import json
from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Tool definition metadata (input_examples, negative_constraint, parameters)
# ---------------------------------------------------------------------------
_TOOL_METADATA: dict[str, dict[str, Any]] = {
    "query_device": {
        "description": "Query device data by action_type",
        "parameters": {
            "type": "object",
            "properties": {
                "action_type": {"type": "string", "description": "The query action type (e.g. interfaces, vlans, routes)"},
                "query_params": {"type": "object", "description": "Optional query parameters"},
            },
            "required": ["action_type"],
        },
        "input_examples": [
            {"action_type": "interfaces", "query_params": {"include_stats": True}},
            {"action_type": "vlans"},
        ],
        "negative_constraint": "仅用于只读查询，不要用于修改设备配置（修改请用 configure）",
    },
    "execute_command": {
        "description": "Execute a command on the device",
        "parameters": {
            "type": "object",
            "properties": {
                "action_type": {"type": "string", "description": "The command action type"},
                "payload": {"type": "object", "description": "Optional command payload"},
            },
            "required": ["action_type"],
        },
        "input_examples": [
            {"action_type": "reboot", "payload": {"graceful": True}},
        ],
        "negative_constraint": "仅用于执行操作命令，不要用于查询数据（查询请用 query_device）；高危操作需确认",
    },
    "collect_metrics": {
        "description": "Collect device metrics",
        "parameters": {
            "type": "object",
            "properties": {},
        },
        "input_examples": [
            {},
        ],
        "negative_constraint": "仅用于采集设备指标数据，不要用于查询配置或执行命令",
    },
    "health_check": {
        "description": "Check device health",
        "parameters": {
            "type": "object",
            "properties": {},
        },
        "input_examples": [
            {},
        ],
        "negative_constraint": "仅用于检查设备健康状态，不要用于采集详细指标（详细指标请用 collect_metrics）",
    },
    "collect_data": {
        "description": "Collect specific data type from device",
        "parameters": {
            "type": "object",
            "properties": {
                "data_type": {"type": "string", "description": "The type of data to collect"},
            },
            "required": ["data_type"],
        },
        "input_examples": [
            {"data_type": "syslog"},
            {"data_type": "arp_table"},
        ],
        "negative_constraint": "仅用于采集特定类型的设备数据，不要用于执行命令或修改配置",
    },
    "configure": {
        "description": "Apply configuration changes",
        "parameters": {
            "type": "object",
            "properties": {
                "action_type": {"type": "string", "description": "The configuration action type"},
                "config": {"type": "object", "description": "Configuration payload"},
            },
            "required": ["action_type", "config"],
        },
        "input_examples": [
            {"action_type": "interface", "config": {"name": "GigabitEthernet0/1", "shutdown": False}},
        ],
        "negative_constraint": "仅用于修改设备配置，不要用于只读查询（查询请用 query_device）；配置变更不可逆，请谨慎使用",
    },
}


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
        """Return simple tool list (name + description) for backward compat.

        Used by ``react_prompt.build_react_system_prompt()`` to build the
        text-based tool descriptions in the system prompt.
        """
        manifest = self._driver.get_capability_manifest()
        base_names = ["query_device", "execute_command", "collect_metrics", "health_check", "collect_data"]
        if manifest.remediation_templates:
            base_names.append("configure")
        return [
            {"name": n, "description": _TOOL_METADATA[n]["description"]}
            for n in base_names
        ]

    # ------------------------------------------------------------------
    # OpenAI function calling schema
    # ------------------------------------------------------------------

    def get_openai_tool_schemas(self) -> list[dict[str, Any]]:
        """Return tool definitions in OpenAI function calling schema format.

        Each entry has ``type: "function"`` with ``function.name``,
        ``function.description`` (enriched with examples & constraints),
        and ``function.parameters`` (JSON Schema).

        Requirements: 3.4, 3.9, 3.10
        """
        manifest = self._driver.get_capability_manifest()
        base_names = ["query_device", "execute_command", "collect_metrics", "health_check", "collect_data"]
        if manifest.remediation_templates:
            base_names.append("configure")

        schemas: list[dict[str, Any]] = []
        for name in base_names:
            meta = _TOOL_METADATA[name]
            schemas.append(_to_openai_schema(name, meta))
        return schemas


def _to_openai_schema(name: str, meta: dict[str, Any]) -> dict[str, Any]:
    """Convert a tool metadata entry to OpenAI function calling schema."""
    desc = meta["description"]
    negative_constraint = meta.get("negative_constraint", "")
    input_examples = meta.get("input_examples", [])

    if negative_constraint:
        desc += f"\n⚠️ 不适用场景: {negative_constraint}"
    if input_examples:
        examples_str = "\n".join(
            f"  示例: {json.dumps(ex, ensure_ascii=False)}"
            for ex in input_examples[:2]
        )
        desc += f"\n调用示例:\n{examples_str}"

    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": meta["parameters"],
        },
    }
