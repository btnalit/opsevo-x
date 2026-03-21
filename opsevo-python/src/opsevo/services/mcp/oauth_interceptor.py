"""OAuthToolCallInterceptor — 为外部 MCP Server 工具调用注入 OAuth Bearer Token。

实现 ToolCallInterceptor 协议 (client_manager.py)，
使用 OAuthTokenManager (security_gateway.py) 管理令牌获取、缓存和刷新。

用法:
    interceptor = OAuthToolCallInterceptor(token_manager)
    interceptor.register_server_oauth("server-1", {
        "token_url": "https://auth.example.com/token",
        "client_id": "xxx",
        "client_secret": "yyy",
        "grant_type": "client_credentials",
    })
    mcp_client_manager.register_interceptor(interceptor)
"""

from __future__ import annotations

from typing import Any

import structlog

from opsevo.services.mcp.security_gateway import OAuthTokenManager

logger = structlog.get_logger(__name__)


class OAuthToolCallInterceptor:
    """工具调用拦截器 — 为配置了 OAuth 的 MCP Server 注入 Bearer Token。"""

    def __init__(self, token_manager: OAuthTokenManager | None = None) -> None:
        self._token_manager = token_manager or OAuthTokenManager()
        # server_id -> OAuth 配置
        self._server_configs: dict[str, dict[str, Any]] = {}

    def register_server_oauth(self, server_id: str, oauth_config: dict[str, Any]) -> None:
        """注册某个 MCP Server 的 OAuth 配置。"""
        self._server_configs[server_id] = oauth_config
        logger.info("oauth_server_registered", server_id=server_id)

    def unregister_server_oauth(self, server_id: str) -> None:
        """移除某个 MCP Server 的 OAuth 配置并清除缓存令牌。"""
        self._server_configs.pop(server_id, None)
        self._token_manager.clear_token(server_id)
        logger.info("oauth_server_unregistered", server_id=server_id)

    async def intercept(
        self, server_id: str, tool_name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        """ToolCallInterceptor 协议实现 — 如果该 server 配置了 OAuth，注入 Bearer Token。

        Token 通过 args 中的 ``_headers`` 字段传递，McpClientManager 在转发时
        会将 ``_headers`` 合并到 HTTP 请求头中。如果 server 未配置 OAuth，
        原样返回 args 不做任何修改。
        """
        config = self._server_configs.get(server_id)
        if not config:
            return args

        try:
            token_info = await self._token_manager.get_token(server_id, config)
            access_token = token_info.get("access_token", "")
            token_type = token_info.get("token_type", "Bearer")

            # 将 Authorization header 注入到 args 的 _headers 字段
            headers = dict(args.get("_headers", {}))
            headers["Authorization"] = f"{token_type} {access_token}"
            return {**args, "_headers": headers}
        except Exception as exc:
            logger.error(
                "oauth_token_injection_failed",
                server_id=server_id,
                tool_name=tool_name,
                error=str(exc),
            )
            # 令牌获取失败时不阻塞调用，原样返回
            return args

    def get_registered_servers(self) -> list[str]:
        """返回已注册 OAuth 的 server ID 列表。"""
        return list(self._server_configs.keys())
