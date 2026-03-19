"""
BrainTools — 9 个工具供自主大脑调用

所有设备交互通过 DeviceDriver 接口，零厂商硬编码。
工具列表：
  query_device, execute_command, analyze_alert, create_remediation,
  invoke_skill, search_knowledge, update_config, send_notification, schedule_task
"""

from __future__ import annotations

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
    ) -> None:
        self._device_pool = device_pool
        self._datastore = datastore
        self._event_bus = event_bus
        self._knowledge_base = knowledge_base
        self._notification_service = notification_service
        self._scheduler = scheduler
        self._skill_factory = skill_factory

        self._tools: dict[str, dict[str, Any]] = self._build_tool_definitions()

    def get_tool_definitions(self) -> list[dict[str, Any]]:
        return list(self._tools.values())

    async def execute(self, tool_name: str, params: dict[str, Any], device_id: str | None = None) -> Any:
        handler = getattr(self, f"_tool_{tool_name}", None)
        if handler is None:
            raise ValueError(f"Unknown brain tool: {tool_name}")
        return await handler(params, device_id=device_id)

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
                channel=params.get("channel", "default"),
                title=params.get("title", "Brain Notification"),
                message=params.get("message", ""),
                severity=params.get("severity", "info"),
            )
            return {"success": True}
        except Exception as exc:
            return {"error": str(exc)}

    async def _tool_schedule_task(self, params: dict, **_: Any) -> dict:
        if not self._scheduler:
            return {"error": "scheduler not available"}
        try:
            task_id = await self._scheduler.add_task(
                name=params.get("name", "brain_task"),
                cron=params.get("cron", ""),
                action=params.get("action", {}),
            )
            return {"success": True, "task_id": task_id}
        except Exception as exc:
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    def _build_tool_definitions(self) -> dict[str, dict[str, Any]]:
        return {
            "query_device": {
                "name": "query_device",
                "description": "Query device data via DeviceDriver interface",
                "parameters": {"device_id": "string", "action_type": "string", "query_params": "object?"},
            },
            "execute_command": {
                "name": "execute_command",
                "description": "Execute a command on device via DeviceDriver interface",
                "parameters": {"device_id": "string", "action_type": "string", "payload": "object?"},
            },
            "analyze_alert": {
                "name": "analyze_alert",
                "description": "Analyze an alert event",
                "parameters": {"alert_id": "string"},
            },
            "create_remediation": {
                "name": "create_remediation",
                "description": "Create a remediation plan for an issue",
                "parameters": {"alert_id": "string", "strategy": "string?"},
            },
            "invoke_skill": {
                "name": "invoke_skill",
                "description": "Invoke a registered skill",
                "parameters": {"skill_name": "string", "input": "object?"},
            },
            "search_knowledge": {
                "name": "search_knowledge",
                "description": "Search the knowledge base",
                "parameters": {"query": "string", "top_k": "number?"},
            },
            "update_config": {
                "name": "update_config",
                "description": "Update device configuration via DeviceDriver",
                "parameters": {"device_id": "string", "action_type": "string", "config": "object"},
            },
            "send_notification": {
                "name": "send_notification",
                "description": "Send a notification",
                "parameters": {"channel": "string?", "title": "string", "message": "string", "severity": "string?"},
            },
            "schedule_task": {
                "name": "schedule_task",
                "description": "Schedule a recurring task",
                "parameters": {"name": "string", "cron": "string", "action": "object"},
            },
        }
