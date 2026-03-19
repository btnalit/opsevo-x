"""
BrainTools — 13 个工具供自主大脑调用

所有设备交互通过 DeviceDriver 接口，零厂商硬编码。
工具列表：
  query_device, execute_command, analyze_alert, create_remediation,
  invoke_skill, search_knowledge, update_config, send_notification, schedule_task,
  create_skill, configure_mcp_server, list_skills, list_mcp_servers
"""

from __future__ import annotations

import json
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class BrainTools:
    """Brain 工具集，所有设备操作通过 DeviceDriver 接口。"""

    def __init__(
        self,
        device_pool: Any = None,
        datastore: Any = None,
        event_bus: Any = None,
        knowledge_base: Any = None,
        notification_service: Any = None,
        scheduler: Any = None,
        skill_factory: Any = None,
        skill_registry: Any = None,
        mcp_client_manager: Any = None,
    ) -> None:
        self._device_pool = device_pool
        self._datastore = datastore
        self._event_bus = event_bus
        self._knowledge_base = knowledge_base
        self._notification_service = notification_service
        self._scheduler = scheduler
        self._skill_factory = skill_factory
        self._skill_registry = skill_registry
        self._mcp_client_manager = mcp_client_manager

        # Rate limiting state for AI self-creation operations
        self._skill_creates_this_tick: int = 0
        self._max_skill_creates_per_tick: int = 2
        self._max_mcp_connections: int = 10

        self._tools: dict[str, dict[str, Any]] = self._build_tool_definitions()

    def get_tool_definitions(self) -> list[dict[str, Any]]:
        return list(self._tools.values())

    async def execute(self, tool_name: str, params: dict[str, Any], device_id: str | None = None) -> Any:
        handler = getattr(self, f"_tool_{tool_name}", None)
        if handler is None:
            raise ValueError(f"Unknown brain tool: {tool_name}")
        return await handler(params, device_id=device_id)

    def reset_tick_counters(self) -> None:
        """Reset per-tick rate limiting counters. Called by Brain at start of each tick."""
        self._skill_creates_this_tick = 0

    async def _write_audit_log(self, action: str, target: str, payload: dict, success: bool, error: str = "") -> None:
        """Write audit entry for AI self-creation operations."""
        import time
        entry = {
            "actor": "brain",
            "action": action,
            "target": target,
            "payload": payload,
            "timestamp": time.time(),
            "success": success,
            "error": error,
        }
        if self._datastore:
            try:
                await self._datastore.insert("audit_log", entry)
            except Exception as exc:
                logger.error("audit_log_insert_failed", action=action, target=target, error=str(exc))
        logger.info("audit_log", **entry)

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------
    async def _tool_query_device(self, params: dict, device_id: str | None = None) -> dict:
        """通过 DeviceDriver 查询设备数据。"""
        did = params.get("device_id") or device_id
        action_type = params.get("action_type", "")
        if not did or not action_type:
            return {"error": "device_id and action_type required"}
        if self._device_pool is None:
            return {"error": "device_pool not available"}
        try:
            driver = await self._device_pool.get_driver(did)
            result = await driver.query(action_type, params.get("query_params"))
            return {"success": True, "data": result}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_execute_command(self, params: dict, device_id: str | None = None) -> dict:
        """通过 DeviceDriver 执行设备命令。"""
        did = params.get("device_id") or device_id
        action_type = params.get("action_type", "")
        if not did or not action_type:
            return {"error": "device_id and action_type required"}
        if self._device_pool is None:
            return {"error": "device_pool not available"}
        try:
            driver = await self._device_pool.get_driver(did)
            result = await driver.execute(action_type, params.get("payload"))
            return {"success": result.success if hasattr(result, "success") else True, "data": result}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_analyze_alert(self, params: dict, **_: Any) -> dict:
        alert_id = params.get("alert_id", "")
        if not alert_id or not self._datastore:
            return {"error": "alert_id required"}
        row = await self._datastore.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
        return {"success": True, "data": row}

    async def _tool_create_remediation(self, params: dict, **_: Any) -> dict:
        return {"success": True, "plan": params}

    async def _tool_invoke_skill(self, params: dict, device_id: str | None = None) -> dict:
        skill_name = params.get("skill_name", "")
        if not skill_name or not self._skill_factory:
            return {"error": "skill_name required or skill_factory not available"}
        try:
            skill = self._skill_factory.get_skill(skill_name)
            result = await skill.execute(params.get("input", {}), device_id=device_id)
            return {"success": True, "data": result}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_search_knowledge(self, params: dict, **_: Any) -> dict:
        query = params.get("query", "")
        if not query or not self._knowledge_base:
            return {"error": "query required"}
        try:
            results = await self._knowledge_base.search(query, top_k=params.get("top_k", 5))
            return {"success": True, "data": results}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_update_config(self, params: dict, device_id: str | None = None) -> dict:
        did = params.get("device_id") or device_id
        action_type = params.get("action_type", "")
        config = params.get("config", {})
        if not did or not action_type or not self._device_pool:
            return {"error": "device_id, action_type required"}
        try:
            driver = await self._device_pool.get_driver(did)
            result = await driver.configure(action_type, config)
            return {"success": True, "data": result}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_send_notification(self, params: dict, **_: Any) -> dict:
        if not self._notification_service:
            return {"error": "notification_service not available"}
        try:
            await self._notification_service.send(
                title=params.get("title", "Brain Notification"),
                message=params.get("message", ""),
                severity=params.get("severity", "info"),
                metadata={"channel": params.get("channel", "default")},
            )
            return {"success": True}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_schedule_task(self, params: dict, **_: Any) -> dict:
        if not self._scheduler:
            return {"error": "scheduler not available"}
        try:
            action = params.get("action", {})
            tool_name = action.get("tool", "")
            tool_params = action.get("params", {})

            async def _action_callback() -> None:
                """Execute the scheduled action via brain_tools.execute."""
                if not tool_name:
                    return
                try:
                    await self.execute(tool_name, tool_params)
                    logger.info("scheduled_action_executed", tool=tool_name)
                except Exception as exc:
                    logger.warning("scheduled_action_failed", tool=tool_name, error=str(exc))

            task_id = await self._scheduler.add_task(
                name=params.get("name", "brain_task"),
                cron=params.get("cron", ""),
                callback=_action_callback,
                metadata={"action": action},
                persist=True,
            )
            return {"success": True, "task_id": task_id}
        except Exception as exc:
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    # AI self-creation tools
    # ------------------------------------------------------------------
    async def _tool_create_skill(self, params: dict, **_: Any) -> dict:
        """Create and register a new Skill."""
        # Rate limit check
        if self._skill_creates_this_tick >= self._max_skill_creates_per_tick:
            await self._write_audit_log("create_skill", params.get("name", ""), params, False, "rate_limit")
            return {"error": "rate_limit", "detail": f"Max {self._max_skill_creates_per_tick} skill creations per tick"}

        name = params.get("name", "")
        definition = params.get("definition")
        if not name or not isinstance(definition, dict) or not definition.get("description"):
            await self._write_audit_log("create_skill", name, params, False, "invalid_params")
            return {"error": "invalid_params", "detail": "name and definition (with description) required"}

        if not self._skill_registry:
            await self._write_audit_log("create_skill", name, params, False, "skill_registry not available")
            return {"error": "skill_registry not available"}

        try:
            metadata = {**definition}
            if params.get("capsule_dir"):
                metadata["capsule_dir"] = params["capsule_dir"]
            # Create in factory first (validates definition); persist only on success
            if self._skill_factory:
                self._skill_factory.create(name, metadata)
            self._skill_registry.register(name, metadata)
            self._skill_creates_this_tick += 1
            await self._write_audit_log("create_skill", name, params, True)
            return {"success": True, "skill_name": name}
        except Exception as exc:
            await self._write_audit_log("create_skill", name, params, False, str(exc))
            return {"error": str(exc)}

    async def _tool_configure_mcp_server(self, params: dict, **_: Any) -> dict:
        """Configure and connect a new external MCP server."""
        server_id = params.get("server_id", "")
        name = params.get("name", "")
        transport = params.get("transport", "")
        connection_params = params.get("connection_params")

        if not server_id or not name or not transport or not isinstance(connection_params, dict):
            await self._write_audit_log("configure_mcp_server", server_id, params, False, "invalid_params")
            return {"error": "invalid_params", "detail": "server_id, name, transport, and connection_params (object) required"}

        if not self._mcp_client_manager:
            await self._write_audit_log("configure_mcp_server", server_id, params, False, "mcp_client_manager not available")
            return {"error": "mcp_client_manager not available"}

        # Check total MCP connections limit
        try:
            status_list = self._mcp_client_manager.get_connection_status()
            if len(status_list) >= self._max_mcp_connections:
                await self._write_audit_log("configure_mcp_server", server_id, params, False, "connection_limit")
                return {"error": "connection_limit", "detail": f"Max {self._max_mcp_connections} MCP connections reached"}
        except Exception as exc:
            logger.warning("mcp_connection_status_check_failed", server_id=server_id, error=str(exc))

        try:
            from opsevo.services.mcp.client_manager import McpServerConfig
            config = McpServerConfig(
                server_id=server_id,
                name=name,
                transport=transport,
                connection_params=connection_params,
            )
            await self._mcp_client_manager.connect_server(config)
            await self._write_audit_log("configure_mcp_server", server_id, params, True)
            return {"success": True, "server_id": server_id}
        except Exception as exc:
            await self._write_audit_log("configure_mcp_server", server_id, params, False, str(exc))
            return {"error": str(exc)}

    async def _tool_list_skills(self, params: dict, **_: Any) -> dict:
        """List all registered skills and their metadata."""
        if not self._skill_registry:
            return {"success": True, "skills": []}
        try:
            return {"success": True, "skills": self._skill_registry.list_all()}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_list_mcp_servers(self, params: dict, **_: Any) -> dict:
        """List all connected MCP servers and their tools."""
        if not self._mcp_client_manager:
            return {"success": True, "servers": []}
        try:
            return {"success": True, "servers": self._mcp_client_manager.get_connection_status()}
        except Exception as exc:
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    # OpenAI schema conversion
    # ------------------------------------------------------------------
    def get_openai_tool_schemas(self) -> list[dict]:
        """Convert tool definitions to OpenAI function calling schema format."""
        schemas: list[dict] = []
        for tool_def in self._tools.values():
            schemas.append(self._tool_def_to_openai_schema(tool_def))
        return schemas

    @staticmethod
    def _params_to_json_schema(params: dict[str, str]) -> dict[str, Any]:
        """Convert simple param format (``{name: type_str}``) to JSON Schema.

        Type strings: ``"string"``, ``"number"``, ``"object"``, ``"boolean"``,
        ``"array"``.  A trailing ``?`` marks the parameter as optional.
        """
        properties: dict[str, Any] = {}
        required: list[str] = []

        _type_map = {
            "string": "string",
            "number": "number",
            "object": "object",
            "boolean": "boolean",
            "array": "array",
        }

        for name, type_str in params.items():
            optional = type_str.endswith("?")
            base_type = type_str.rstrip("?")
            json_type = _type_map.get(base_type, "string")
            properties[name] = {"type": json_type}
            if not optional:
                required.append(name)

        schema: dict[str, Any] = {"type": "object", "properties": properties}
        if required:
            schema["required"] = required
        return schema

    @staticmethod
    def _tool_def_to_openai_schema(tool_def: dict[str, Any]) -> dict[str, Any]:
        """Convert a single tool definition to OpenAI function calling schema.

        The description is enriched with ``negative_constraint`` and
        ``input_examples`` when present.
        """
        desc = tool_def["description"]
        negative_constraint = tool_def.get("negative_constraint", "")
        input_examples = tool_def.get("input_examples", [])

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
                "name": tool_def["name"],
                "description": desc,
                "parameters": BrainTools._params_to_json_schema(tool_def["parameters"]),
            },
        }

    # ------------------------------------------------------------------
    def _build_tool_definitions(self) -> dict[str, dict[str, Any]]:
        return {
            "query_device": {
                "name": "query_device",
                "description": "Query device data via DeviceDriver interface",
                "parameters": {"device_id": "string", "action_type": "string", "query_params": "object?"},
                "input_examples": [
                    {"device_id": "router-01", "action_type": "interfaces", "query_params": {"include_stats": True}},
                    {"device_id": "switch-03", "action_type": "vlans"},
                ],
                "negative_constraint": "仅用于只读查询，不要用于修改设备配置（修改请用 update_config）",
            },
            "execute_command": {
                "name": "execute_command",
                "description": "Execute a command on device via DeviceDriver interface",
                "parameters": {"device_id": "string", "action_type": "string", "payload": "object?"},
                "input_examples": [
                    {"device_id": "router-01", "action_type": "reboot", "payload": {"graceful": True}},
                ],
                "negative_constraint": "仅用于执行操作命令，不要用于查询数据（查询请用 query_device）；高危操作需确认",
            },
            "analyze_alert": {
                "name": "analyze_alert",
                "description": "Analyze an alert event",
                "parameters": {"alert_id": "string"},
                "input_examples": [
                    {"alert_id": "alert-2024-001"},
                ],
                "negative_constraint": "仅用于分析已有告警，不要用于创建或修改告警规则",
            },
            "create_remediation": {
                "name": "create_remediation",
                "description": "Create a remediation plan for an issue",
                "parameters": {"alert_id": "string", "strategy": "string?"},
                "input_examples": [
                    {"alert_id": "alert-2024-001", "strategy": "restart_service"},
                    {"alert_id": "alert-2024-002"},
                ],
                "negative_constraint": "仅用于创建修复计划，不要用于直接执行修复操作（执行请用 execute_command）",
            },
            "invoke_skill": {
                "name": "invoke_skill",
                "description": "Invoke a registered skill",
                "parameters": {"skill_name": "string", "input": "object?"},
                "input_examples": [
                    {"skill_name": "traffic-analysis", "input": {"device_id": "router-01", "period": "1h"}},
                ],
                "negative_constraint": "仅用于调用已注册的 Skill，不要用于创建新 Skill（创建请用 create_skill）",
            },
            "search_knowledge": {
                "name": "search_knowledge",
                "description": "Search the knowledge base",
                "parameters": {"query": "string", "top_k": "number?"},
                "input_examples": [
                    {"query": "BGP neighbor flapping troubleshooting", "top_k": 5},
                    {"query": "OSPF configuration best practices"},
                ],
                "negative_constraint": "仅用于搜索知识库，不要用于查询实时设备数据（实时数据请用 query_device）",
            },
            "update_config": {
                "name": "update_config",
                "description": "Update device configuration via DeviceDriver",
                "parameters": {"device_id": "string", "action_type": "string", "config": "object"},
                "input_examples": [
                    {"device_id": "router-01", "action_type": "interface", "config": {"name": "GigabitEthernet0/1", "shutdown": False}},
                ],
                "negative_constraint": "仅用于修改设备配置，不要用于只读查询（查询请用 query_device）；配置变更不可逆，请谨慎使用",
            },
            "send_notification": {
                "name": "send_notification",
                "description": "Send a notification",
                "parameters": {"channel": "string?", "title": "string", "message": "string", "severity": "string?"},
                "input_examples": [
                    {"channel": "ops-team", "title": "High CPU Alert", "message": "Router-01 CPU usage exceeded 90%", "severity": "warning"},
                ],
                "negative_constraint": "仅用于发送通知消息，不要用于记录审计日志或执行修复操作",
            },
            "schedule_task": {
                "name": "schedule_task",
                "description": "Schedule a recurring task",
                "parameters": {"name": "string", "cron": "string", "action": "object"},
                "input_examples": [
                    {"name": "daily_health_check", "cron": "0 8 * * *", "action": {"tool": "query_device", "params": {"device_id": "router-01", "action_type": "health"}}},
                ],
                "negative_constraint": "仅用于创建定时任务，不要用于立即执行操作（立即执行请用 execute_command）",
            },
            "create_skill": {
                "name": "create_skill",
                "description": "Create and register a new skill",
                "parameters": {"name": "string", "definition": "object", "capsule_dir": "string?"},
                "input_examples": [
                    {"name": "traffic-monitor", "definition": {"description": "Monitor traffic patterns", "runtime": "python", "tools": []}},
                ],
                "negative_constraint": "仅用于创建新 Skill，不要用于调用已有 Skill（调用请用 invoke_skill）；受速率限制",
            },
            "configure_mcp_server": {
                "name": "configure_mcp_server",
                "description": "Configure and connect a new external MCP server",
                "parameters": {"server_id": "string", "name": "string", "transport": "string", "connection_params": "object"},
                "input_examples": [
                    {"server_id": "weather-api", "name": "Weather API", "transport": "http", "connection_params": {"url": "https://api.weather.example.com/mcp"}},
                ],
                "negative_constraint": "仅用于配置新 MCP Server 连接，不要用于调用已有工具；受总连接数限制",
            },
            "list_skills": {
                "name": "list_skills",
                "description": "List all registered skills and their metadata",
                "parameters": {},
                "input_examples": [{}],
                "negative_constraint": "仅用于查询已注册 Skill 列表，不要用于调用或创建 Skill",
            },
            "list_mcp_servers": {
                "name": "list_mcp_servers",
                "description": "List all connected MCP servers and their tools",
                "parameters": {},
                "input_examples": [{}],
                "negative_constraint": "仅用于查询 MCP Server 连接状态，不要用于配置新 Server",
            },
        }
