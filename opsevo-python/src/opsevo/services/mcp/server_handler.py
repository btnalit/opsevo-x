"""
McpServerHandler — MCP SDK Server 核心

通过 Streamable HTTP 传输对外暴露 OPSEVO 的网络运维工具和资源。
每个 HTTP 请求创建独立的传输实例（无状态模式）。
SecurityContext 从请求中间件注入。
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)


class McpToolResult:
    """MCP 工具调用结果。"""

    def __init__(
        self,
        content: list[dict[str, str]],
        is_error: bool = False,
    ) -> None:
        self.content = content
        self.is_error = is_error

    def to_dict(self) -> dict[str, Any]:
        return {"content": self.content, "isError": self.is_error}


class McpServerHandler:
    """MCP Server 处理器，注册工具和资源并处理 HTTP 请求。"""

    def __init__(
        self,
        server_name: str = "opsevo-mcp-server",
        server_version: str = "1.0.0",
    ) -> None:
        self.server_name = server_name
        self.server_version = server_version
        self._tools: dict[str, dict[str, Any]] = {}
        self._resources: dict[str, dict[str, Any]] = {}
        self._tool_handlers: dict[str, Callable[..., Awaitable[McpToolResult]]] = {}
        self._resource_handlers: dict[str, Callable[..., Awaitable[dict]]] = {}
        # Service references (injected)
        self._intent_registry: Any = None
        self._metrics_collector: Any = None
        self._knowledge_graph: Any = None
        self._alert_pipeline: Any = None
        self._config_snapshot: Any = None
        self._audit_logger: Any = None
        logger.info(
            "McpServerHandler initialized",
            name=server_name,
            version=server_version,
        )

    def set_services(self, **services: Any) -> None:
        """注入内部服务引用。"""
        for key, svc in services.items():
            setattr(self, f"_{key}", svc)

    # ------------------------------------------------------------------
    # 工具注册
    # ------------------------------------------------------------------

    def register_tool(
        self,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        handler: Callable[..., Awaitable[McpToolResult]],
    ) -> None:
        self._tools[name] = {
            "name": name,
            "description": description,
            "inputSchema": input_schema,
        }
        self._tool_handlers[name] = handler

    def register_resource(
        self,
        uri: str,
        name: str,
        description: str,
        handler: Callable[..., Awaitable[dict]],
    ) -> None:
        self._resources[uri] = {
            "uri": uri,
            "name": name,
            "description": description,
        }
        self._resource_handlers[uri] = handler

    def register_builtin_tools(self) -> None:
        """注册所有内置 MCP 工具。"""

        async def handle_diagnose(args: dict) -> McpToolResult:
            return await self._handle_intent_tool(
                "network.diagnose", args, "diagnose network issues"
            )

        async def handle_alert_analyze(args: dict) -> McpToolResult:
            return await self._handle_intent_tool(
                "alert.analyze", args, "analyze alerts"
            )

        async def handle_topology_query(args: dict) -> McpToolResult:
            return await self._handle_intent_tool(
                "topology.query", args, "query topology"
            )

        async def handle_metrics_latest(args: dict) -> McpToolResult:
            return await self._handle_data_query("metrics.getLatest", args)

        async def handle_metrics_history(args: dict) -> McpToolResult:
            return await self._handle_data_query("metrics.getHistory", args)

        async def handle_alert_history(args: dict) -> McpToolResult:
            return await self._handle_data_query("alert.getHistory", args)

        self.register_tool(
            "network.diagnose",
            "Diagnose network issues for a device or interface",
            {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string"},
                    "interfaceName": {"type": "string"},
                    "symptoms": {"type": "string"},
                },
            },
            handle_diagnose,
        )
        self.register_tool(
            "alert.analyze",
            "Analyze recent alerts and provide root cause analysis",
            {
                "type": "object",
                "properties": {
                    "alertId": {"type": "string"},
                    "timeRange": {"type": "string"},
                },
            },
            handle_alert_analyze,
        )
        self.register_tool(
            "topology.query",
            "Query network topology information",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "deviceId": {"type": "string"},
                },
            },
            handle_topology_query,
        )
        self.register_tool(
            "metrics.getLatest",
            "Get latest metrics for a device",
            {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string"},
                    "metricType": {"type": "string"},
                },
            },
            handle_metrics_latest,
        )
        self.register_tool(
            "metrics.getHistory",
            "Get historical metrics for a device",
            {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string"},
                    "metricType": {"type": "string"},
                    "timeRange": {"type": "string"},
                },
            },
            handle_metrics_history,
        )
        self.register_tool(
            "alert.getHistory",
            "Get alert history",
            {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string"},
                    "severity": {"type": "string"},
                    "limit": {"type": "integer"},
                },
            },
            handle_alert_history,
        )

    # ------------------------------------------------------------------
    # 内部处理
    # ------------------------------------------------------------------

    async def _handle_intent_tool(
        self,
        tool_name: str,
        args: dict[str, Any],
        description: str,
    ) -> McpToolResult:
        """通过 IntentRegistry 执行高层意图工具。"""
        try:
            if self._intent_registry:
                result = await self._intent_registry.execute_intent(tool_name, args)
                return McpToolResult(
                    content=[{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]
                )
            return McpToolResult(
                content=[{"type": "text", "text": f"Intent service unavailable for {tool_name}"}],
                is_error=True,
            )
        except Exception as exc:
            logger.error("MCP intent tool error", tool=tool_name, error=str(exc))
            return McpToolResult(
                content=[{"type": "text", "text": f"Error: {exc}"}],
                is_error=True,
            )

    async def _handle_data_query(
        self,
        tool_name: str,
        args: dict[str, Any],
    ) -> McpToolResult:
        """处理数据查询工具。"""
        try:
            if self._metrics_collector and "metrics" in tool_name:
                data = {"tool": tool_name, "args": args, "timestamp": time.time()}
                return McpToolResult(
                    content=[{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]
                )
            return McpToolResult(
                content=[{"type": "text", "text": f"Data query service unavailable for {tool_name}"}],
                is_error=True,
            )
        except Exception as exc:
            logger.error("MCP data query error", tool=tool_name, error=str(exc))
            return McpToolResult(
                content=[{"type": "text", "text": f"Error: {exc}"}],
                is_error=True,
            )

    # ------------------------------------------------------------------
    # HTTP 处理（FastAPI 集成）
    # ------------------------------------------------------------------

    async def handle_request(
        self,
        method: str,
        body: dict[str, Any] | None,
        security_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """处理 MCP 协议 HTTP 请求。"""
        if not body:
            return {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}

        jsonrpc_method = body.get("method", "")
        params = body.get("params", {})
        req_id = body.get("id")

        if jsonrpc_method == "initialize":
            return self._handle_initialize(req_id)
        elif jsonrpc_method == "tools/list":
            return self._handle_tools_list(req_id)
        elif jsonrpc_method == "tools/call":
            return await self._handle_tools_call(req_id, params, security_context)
        elif jsonrpc_method == "resources/list":
            return self._handle_resources_list(req_id)
        elif jsonrpc_method == "resources/read":
            return await self._handle_resources_read(req_id, params, security_context)
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {jsonrpc_method}"},
            }

    def _handle_initialize(self, req_id: Any) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {
                    "name": self.server_name,
                    "version": self.server_version,
                },
            },
        }

    def _handle_tools_list(self, req_id: Any) -> dict[str, Any]:
        tools = list(self._tools.values())
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools}}

    async def _handle_tools_call(
        self,
        req_id: Any,
        params: dict[str, Any],
        security_context: dict[str, Any] | None,
    ) -> dict[str, Any]:
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        handler = self._tool_handlers.get(tool_name)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"},
            }
        try:
            result = await handler(arguments)
            await self._log_tool_audit(tool_name, arguments, result, security_context)
            return {"jsonrpc": "2.0", "id": req_id, "result": result.to_dict()}
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(exc)},
            }

    def _handle_resources_list(self, req_id: Any) -> dict[str, Any]:
        resources = list(self._resources.values())
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": resources}}

    async def _handle_resources_read(
        self,
        req_id: Any,
        params: dict[str, Any],
        security_context: dict[str, Any] | None,
    ) -> dict[str, Any]:
        uri = params.get("uri", "")
        handler = self._resource_handlers.get(uri)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"Unknown resource: {uri}"},
            }
        try:
            result = await handler(params)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(exc)},
            }

    async def _log_tool_audit(
        self,
        tool_name: str,
        args: dict,
        result: McpToolResult,
        security_context: dict[str, Any] | None,
    ) -> None:
        if self._audit_logger:
            try:
                await self._audit_logger.log({
                    "action": "mcp_tool_call",
                    "actor": "system",
                    "source": "mcp_server",
                    "details": {
                        "tool": tool_name,
                        "isError": result.is_error,
                        "tenantId": (security_context or {}).get("tenant_id"),
                    },
                })
            except Exception:
                pass

    def get_tool_names(self) -> list[str]:
        return list(self._tools.keys())

    def get_resource_uris(self) -> list[str]:
        return list(self._resources.keys())
