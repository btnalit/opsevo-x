"""
SecurityGateway — MCP Server 安全网关

FastAPI 中间件/依赖，负责认证（API Key）、授权（角色权限矩阵）、限流（滑动窗口）。
"""

from __future__ import annotations

import time
from typing import Any

import structlog
from fastapi import HTTPException, Request

from opsevo.services.mcp.api_key_manager import ApiKeyManager, SecurityContext

logger = structlog.get_logger(__name__)

# 角色权限等级
ROLE_LEVEL: dict[str, int] = {"viewer": 0, "operator": 1, "admin": 2}

# 工具类别对应的最低角色
TOOL_MIN_ROLE: dict[str, str] = {
    "metrics.getLatest": "viewer",
    "metrics.getHistory": "viewer",
    "alert.getHistory": "viewer",
    "topology.getSnapshot": "viewer",
    "network.diagnose": "operator",
    "alert.analyze": "operator",
    "topology.query": "operator",
    "device.executeCommand": "admin",
    "device.getConfig": "admin",
}


def check_role_permission(request_role: str, min_role: str) -> bool:
    """检查请求者角色是否满足最低角色要求。"""
    request_level = ROLE_LEVEL.get(request_role, -1)
    required_level = ROLE_LEVEL.get(min_role, 999)
    return request_level >= required_level


def get_tool_min_role(tool_name: str) -> str:
    """获取工具的最低角色要求。"""
    return TOOL_MIN_ROLE.get(tool_name, "admin")


class SecurityGateway:
    """MCP 安全网关，作为 FastAPI 依赖使用。"""

    def __init__(
        self,
        api_key_manager: ApiKeyManager,
        per_tenant_rate_limit: int = 60,
    ) -> None:
        self._api_key_manager = api_key_manager
        self._rate_limit = per_tenant_rate_limit
        self._window_ms = 60_000
        self._rate_map: dict[str, dict[str, Any]] = {}

    async def authenticate(self, request: Request) -> SecurityContext:
        """从请求中提取并验证 API Key，返回 SecurityContext。"""
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            raise HTTPException(
                status_code=401,
                detail="Authentication required. Provide Authorization: Bearer <api-key>",
            )

        raw_key = auth_header[7:]
        ctx = await self._api_key_manager.validate_key(raw_key)
        if not ctx:
            raise HTTPException(status_code=401, detail="Invalid or revoked API Key")

        client_id = request.headers.get("user-agent") or request.headers.get("x-client-id") or "unknown"
        ctx.client_id = client_id

        # 限流
        now = time.time() * 1000
        entry = self._rate_map.get(ctx.tenant_id)
        if not entry or now - entry["window_start"] >= self._window_ms:
            entry = {"window_start": now, "count": 0}
            self._rate_map[ctx.tenant_id] = entry
        entry["count"] += 1
        if entry["count"] > self._rate_limit:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        return ctx


class OAuthTokenManager:
    """OAuth 令牌管理器 — 管理外部 MCP Server 的 OAuth 令牌获取、缓存和刷新。"""

    def __init__(self, fetch_timeout_ms: int = 10_000) -> None:
        self._token_cache: dict[str, dict[str, Any]] = {}
        self._fetch_timeout = fetch_timeout_ms / 1000

    async def get_token(self, server_id: str, config: dict[str, Any]) -> dict[str, Any]:
        """获取有效令牌（缓存优先）。"""
        skew = config.get("refresh_skew_seconds", 60) * 1000
        cached = self._token_cache.get(server_id)
        if cached and not self._is_expiring(cached, skew):
            return cached
        token = await self._fetch_token(config)
        self._token_cache[server_id] = token
        return token

    async def _fetch_token(self, config: dict[str, Any]) -> dict[str, Any]:
        import httpx

        data = {
            "grant_type": config["grant_type"],
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
        }
        if config["grant_type"] == "refresh_token" and config.get("refresh_token"):
            data["refresh_token"] = config["refresh_token"]
        if config.get("scope"):
            data["scope"] = config["scope"]

        async with httpx.AsyncClient(timeout=self._fetch_timeout) as client:
            resp = await client.post(
                config["token_url"],
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            body = resp.json()

        token_field = config.get("token_field", "access_token")
        expires_field = config.get("expires_in_field", "expires_in")
        return {
            "access_token": body[token_field],
            "token_type": body.get(config.get("token_type_field", "token_type"), "Bearer"),
            "expires_at": time.time() * 1000 + body.get(expires_field, 3600) * 1000,
        }

    def _is_expiring(self, token: dict[str, Any], skew_ms: float) -> bool:
        return time.time() * 1000 >= token.get("expires_at", 0) - skew_ms

    def clear_token(self, server_id: str) -> None:
        self._token_cache.pop(server_id, None)


class EnvVarResolver:
    """环境变量解析器 — 递归替换配置中的 $ENV_VAR 引用。"""

    @staticmethod
    def resolve(config: Any) -> Any:
        import os
        import re

        if config is None:
            return config
        if isinstance(config, str):
            if re.match(r"^\$[A-Za-z_][A-Za-z0-9_]*$", config):
                var_name = config[1:]
                val = os.environ.get(var_name)
                if val is None:
                    logger.warn("Env var not defined", var=var_name)
                    return ""
                return val
            return config
        if isinstance(config, list):
            return [EnvVarResolver.resolve(item) for item in config]
        if isinstance(config, dict):
            return {k: EnvVarResolver.resolve(v) for k, v in config.items()}
        return config
