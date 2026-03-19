"""
McpClientManager — 外部 MCP Server 连接管理

管理与外部 MCP Server 的连接（stdio/SSE/HTTP 三种传输），
工具发现，拦截器链，健康检查，配置热更新。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class McpServerConfig:
    """外部 MCP Server 配置。"""

    server_id: str
    name: str
    transport: str  # stdio | sse | http
    enabled: bool = True
    connection_params: dict[str, Any] = field(default_factory=dict)
    oauth: dict[str, Any] | None = None


@dataclass
class McpToolDefinition:
    """MCP 工具定义。"""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    server_id: str = ""


@dataclass
class McpConnection:
    """MCP 连接状态。"""

    server_id: str
    config: McpServerConfig
    status: str = "disconnected"  # connecting | connected | disconnected
    discovered_tools: list[McpToolDefinition] = field(default_factory=list)
    last_health_check: float = 0.0
    consecutive_failures: int = 0
    _http_client: httpx.AsyncClient | None = None


class ToolCallInterceptor(Protocol):
    """工具调用拦截器协议。"""

    async def intercept(
        self, server_id: str, tool_name: str, args: dict[str, Any]
    ) -> dict[str, Any]: ...


class McpClientManager:
    """外部 MCP Server 连接管理器。"""

    def __init__(
        self,
        tool_registry: Any = None,
        config_file_path: str = "",
        forward_timeout_ms: int = 30_000,
        health_check_interval_ms: int = 30_000,
        max_consecutive_failures: int = 3,
    ) -> None:
        self._tool_registry = tool_registry
        self._config_file_path = config_file_path
        self._forward_timeout_ms = forward_timeout_ms
        self._health_check_interval_ms = health_check_interval_ms
        self._max_consecutive_failures = max_consecutive_failures
        self._connections: dict[str, McpConnection] = {}
        self._interceptors: list[ToolCallInterceptor] = []
        self._health_check_task: asyncio.Task[None] | None = None

        if tool_registry:
            tool_registry.set_tool_forwarder(self)

    # ------------------------------------------------------------------
    # 初始化
    # ------------------------------------------------------------------

    async def initialize(self, configs: list[McpServerConfig]) -> None:
        """从配置连接所有 enabled 的外部 Server。"""
        resolved = [self._resolve_env_vars(c) for c in configs]
        for cfg in resolved:
            if cfg.enabled:
                await self.connect_server(cfg)
        self._start_health_check()
        logger.info(
            "McpClientManager initialized",
            connected=len([c for c in self._connections.values() if c.status == "connected"]),
        )

    async def connect_server(self, config: McpServerConfig) -> None:
        """连接到单个外部 MCP Server。"""
        sid = config.server_id
        conn = McpConnection(server_id=sid, config=config, status="connecting")
        self._connections[sid] = conn

        try:
            if config.transport == "http":
                url = config.connection_params.get("url", "")
                headers = config.connection_params.get("headers", {})
                client = httpx.AsyncClient(
                    base_url=url,
                    headers=headers,
                    timeout=self._forward_timeout_ms / 1000,
                )
                conn._http_client = client
                # 发送 initialize 请求
                resp = await client.post(
                    "/",
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {},
                            "clientInfo": {"name": "opsevo-client", "version": "1.0.0"},
                        },
                    },
                )
                resp.raise_for_status()
                # 发现工具
                tools_resp = await client.post(
                    "/",
                    json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                )
                tools_data = tools_resp.json()
                tools = tools_data.get("result", {}).get("tools", [])
                conn.discovered_tools = [
                    McpToolDefinition(
                        name=t["name"],
                        description=t.get("description", ""),
                        input_schema=t.get("inputSchema", {}),
                        server_id=sid,
                    )
                    for t in tools
                ]
                conn.status = "connected"
                if self._tool_registry:
                    self._tool_registry.register_external_tools(sid, conn.discovered_tools)
                logger.info("MCP server connected", server_id=sid, tools=len(conn.discovered_tools))
            elif config.transport == "stdio":
                # stdio 传输：启动子进程
                logger.info("MCP stdio transport not yet implemented", server_id=sid)
                conn.status = "disconnected"
            elif config.transport == "sse":
                logger.info("MCP SSE transport not yet implemented", server_id=sid)
                conn.status = "disconnected"
            else:
                logger.warn("Unknown MCP transport", transport=config.transport)
                conn.status = "disconnected"
        except Exception as exc:
            conn.status = "disconnected"
            conn.consecutive_failures += 1
            logger.error("Failed to connect MCP server", server_id=sid, error=str(exc))

    async def disconnect_server(self, server_id: str) -> None:
        conn = self._connections.pop(server_id, None)
        if not conn:
            return
        if conn._http_client:
            await conn._http_client.aclose()
        if self._tool_registry:
            self._tool_registry.unregister_external_tools(server_id)
        logger.info("MCP server disconnected", server_id=server_id)

    # ------------------------------------------------------------------
    # 工具转发
    # ------------------------------------------------------------------

    async def forward_call(
        self, server_id: str, tool_name: str, args: dict[str, Any]
    ) -> Any:
        """转发工具调用到外部 MCP Server。"""
        conn = self._connections.get(server_id)
        if not conn or conn.status != "connected":
            raise RuntimeError(f"MCP server not connected: {server_id}")

        # 执行拦截器链
        intercepted_args = args
        for interceptor in self._interceptors:
            intercepted_args = await interceptor.intercept(server_id, tool_name, intercepted_args)

        if conn._http_client:
            resp = await conn._http_client.post(
                "/",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": intercepted_args},
                },
            )
            data = resp.json()
            if "error" in data:
                raise RuntimeError(data["error"].get("message", "Unknown MCP error"))
            return data.get("result")
        raise RuntimeError(f"No transport available for server: {server_id}")

    def register_interceptor(self, interceptor: ToolCallInterceptor) -> None:
        self._interceptors.append(interceptor)

    # ------------------------------------------------------------------
    # 配置热更新
    # ------------------------------------------------------------------

    async def on_config_change(self, new_configs: list[McpServerConfig]) -> None:
        """配置变更时重新连接。"""
        new_ids = {c.server_id for c in new_configs}
        current_ids = set(self._connections.keys())

        # 断开已移除的
        for sid in current_ids - new_ids:
            await self.disconnect_server(sid)

        # 连接新增的
        for cfg in new_configs:
            if cfg.server_id not in current_ids and cfg.enabled:
                await self.connect_server(cfg)

    # ------------------------------------------------------------------
    # 健康检查
    # ------------------------------------------------------------------

    def _start_health_check(self) -> None:
        if self._health_check_task and not self._health_check_task.done():
            return

        async def _check_loop() -> None:
            while True:
                await asyncio.sleep(self._health_check_interval_ms / 1000)
                for conn in list(self._connections.values()):
                    if conn.status != "connected" or not conn._http_client:
                        continue
                    try:
                        resp = await conn._http_client.post(
                            "/",
                            json={"jsonrpc": "2.0", "id": 0, "method": "ping", "params": {}},
                        )
                        conn.last_health_check = time.time()
                        conn.consecutive_failures = 0
                    except Exception:
                        conn.consecutive_failures += 1
                        if conn.consecutive_failures >= self._max_consecutive_failures:
                            conn.status = "disconnected"
                            logger.warn("MCP server unhealthy", server_id=conn.server_id)

        self._health_check_task = asyncio.create_task(_check_loop())

    # ------------------------------------------------------------------
    # 状态查询
    # ------------------------------------------------------------------

    def get_connection_status(self) -> list[dict[str, Any]]:
        return [
            {
                "serverId": c.server_id,
                "name": c.config.name,
                "status": c.status,
                "transport": c.config.transport,
                "toolCount": len(c.discovered_tools),
                "healthy": c.consecutive_failures == 0,
            }
            for c in self._connections.values()
        ]

    def get_server_tools(self, server_id: str) -> list[McpToolDefinition]:
        conn = self._connections.get(server_id)
        return list(conn.discovered_tools) if conn else []

    async def shutdown(self) -> None:
        if self._health_check_task and not self._health_check_task.done():
            self._health_check_task.cancel()
        for sid in list(self._connections.keys()):
            await self.disconnect_server(sid)
        logger.info("McpClientManager shutdown")

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_env_vars(config: McpServerConfig) -> McpServerConfig:
        """解析配置中的 $ENV_VAR 引用。"""
        import os
        import re

        def _resolve(val: Any) -> Any:
            if isinstance(val, str) and re.match(r"^\$[A-Za-z_][A-Za-z0-9_]*$", val):
                return os.environ.get(val[1:], "")
            if isinstance(val, dict):
                return {k: _resolve(v) for k, v in val.items()}
            if isinstance(val, list):
                return [_resolve(v) for v in val]
            return val

        resolved_params = _resolve(config.connection_params)
        return McpServerConfig(
            server_id=config.server_id,
            name=config.name,
            transport=config.transport,
            enabled=config.enabled,
            connection_params=resolved_params,
            oauth=config.oauth,
        )
