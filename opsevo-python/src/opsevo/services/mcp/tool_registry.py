"""
ToolRegistry — 统一工具注册表

合并本地 brainTools 和远程 MCP 工具到统一接口。
支持工具缓存、健康状态跟踪、工具转发。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class UnifiedTool:
    """统一工具定义。"""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    source: str = "local"  # local | external
    server_id: str | None = None
    healthy: bool = True


class IToolForwarder(Protocol):
    """工具转发器协议。"""

    async def forward_call(
        self, server_id: str, tool_name: str, args: dict[str, Any]
    ) -> Any: ...


class ToolRegistry:
    """统一工具注册表。"""

    def __init__(self, config_file_path: str = "") -> None:
        self._config_file_path = config_file_path
        self._local_tools: dict[str, UnifiedTool] = {}
        self._external_tools: dict[str, dict[str, UnifiedTool]] = {}  # server_id -> {name: tool}
        self._server_health: dict[str, bool] = {}
        self._forwarder: IToolForwarder | None = None
        self._local_handlers: dict[str, Any] = {}
        self._cache_timestamp: float = 0.0
        self._on_cache_invalidated: Any = None

    def set_tool_forwarder(self, forwarder: IToolForwarder) -> None:
        self._forwarder = forwarder

    def set_on_cache_invalidated(self, callback: Any) -> None:
        self._on_cache_invalidated = callback

    # ------------------------------------------------------------------
    # 本地工具注册
    # ------------------------------------------------------------------

    def register_local_tools(
        self, tools: list[dict[str, Any]]
    ) -> None:
        """注册本地 brainTools。"""
        for t in tools:
            name = t.get("name", "")
            tool = UnifiedTool(
                name=name,
                description=t.get("description", ""),
                input_schema=t.get("inputSchema", t.get("input_schema", {})),
                source="local",
            )
            self._local_tools[name] = tool
            if "handler" in t:
                self._local_handlers[name] = t["handler"]
        self._cache_timestamp = time.time()
        logger.info("Local tools registered", count=len(tools))

    # ------------------------------------------------------------------
    # 外部工具注册
    # ------------------------------------------------------------------

    def register_external_tools(
        self, server_id: str, tools: list[Any]
    ) -> None:
        """注册外部 MCP Server 发现的工具。"""
        tool_map: dict[str, UnifiedTool] = {}
        for t in tools:
            name = getattr(t, "name", "") if hasattr(t, "name") else t.get("name", "")
            desc = getattr(t, "description", "") if hasattr(t, "description") else t.get("description", "")
            schema = getattr(t, "input_schema", {}) if hasattr(t, "input_schema") else t.get("inputSchema", {})
            tool_map[name] = UnifiedTool(
                name=name,
                description=desc,
                input_schema=schema,
                source="external",
                server_id=server_id,
            )
        self._external_tools[server_id] = tool_map
        self._server_health[server_id] = True
        self._cache_timestamp = time.time()
        logger.info("External tools registered", server_id=server_id, count=len(tools))

    def unregister_external_tools(self, server_id: str) -> None:
        self._external_tools.pop(server_id, None)
        self._server_health.pop(server_id, None)
        self._cache_timestamp = time.time()

    def set_server_health(self, server_id: str, healthy: bool) -> None:
        self._server_health[server_id] = healthy

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get_all_tools(self) -> list[UnifiedTool]:
        """获取所有可用工具（本地 + 健康的外部）。"""
        tools: list[UnifiedTool] = list(self._local_tools.values())
        for sid, tool_map in self._external_tools.items():
            if self._server_health.get(sid, False):
                tools.extend(tool_map.values())
        return tools

    def get_external_tool_count(self, server_id: str) -> int:
        return len(self._external_tools.get(server_id, {}))

    def get_external_tools_by_server(self, server_id: str) -> list[UnifiedTool]:
        return list(self._external_tools.get(server_id, {}).values())

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------

    async def execute_tool(
        self, tool_name: str, params: dict[str, Any]
    ) -> Any:
        """执行工具（本地直接调用，外部通过 forwarder 转发）。"""
        # 本地工具
        if tool_name in self._local_tools:
            handler = self._local_handlers.get(tool_name)
            if handler:
                return await handler(params)
            raise RuntimeError(f"No handler for local tool: {tool_name}")

        # 外部工具
        for sid, tool_map in self._external_tools.items():
            if tool_name in tool_map and self._server_health.get(sid, False):
                if not self._forwarder:
                    raise RuntimeError("No tool forwarder configured")
                return await self._forwarder.forward_call(sid, tool_name, params)

        raise RuntimeError(f"Tool not found: {tool_name}")
