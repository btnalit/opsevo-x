"""
MCP API 路由

端点:
- ALL  /mcp                              MCP Server Streamable HTTP 端点
- GET  /api/mcp/keys                     列出 API Keys
- POST /api/mcp/keys                     创建 API Key
- DELETE /api/mcp/keys/{key_id}          撤销 API Key
- GET  /api/mcp/server/status            MCP Server 状态
- GET  /api/mcp/client/servers           列出外部 Server
- POST /api/mcp/client/servers           添加外部 Server
- DELETE /api/mcp/client/servers/{id}    移除外部 Server
- GET  /api/mcp/client/status            MCP Client 状态
- GET  /api/mcp/tools                    列出所有工具
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from opsevo.api.deps import get_current_user

router = APIRouter(tags=["mcp"])


# ------------------------------------------------------------------
# Request models
# ------------------------------------------------------------------

class CreateKeyRequest(BaseModel):
    tenant_id: str
    role: str
    label: str


class AddServerRequest(BaseModel):
    server_id: str
    name: str
    transport: str  # stdio | sse | http
    enabled: bool = True
    connection_params: dict[str, Any] = {}
    oauth: dict[str, Any] | None = None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _get_mcp_server(request: Request):
    return getattr(request.app.state.container, "mcp_server_handler", None)


def _get_mcp_client(request: Request):
    return getattr(request.app.state.container, "mcp_client_manager", None)


def _get_api_key_manager(request: Request):
    return getattr(request.app.state.container, "api_key_manager", None)


def _get_tool_registry(request: Request):
    return getattr(request.app.state.container, "tool_registry", None)


# ------------------------------------------------------------------
# MCP Protocol 端点
# ------------------------------------------------------------------

@router.api_route("/mcp", methods=["GET", "POST", "PUT", "DELETE"])
async def mcp_protocol_endpoint(request: Request):
    """MCP Server Streamable HTTP 端点。"""
    handler = _get_mcp_server(request)
    if not handler:
        raise HTTPException(503, "MCP Server not available")

    # 安全网关认证
    security_gateway = getattr(request.app.state.container, "security_gateway", None)
    security_context = None
    if security_gateway:
        try:
            security_context = await security_gateway.authenticate(request)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(401, "Authentication failed")

    body = None
    if request.method in ("POST", "PUT"):
        body = await request.json()

    result = await handler.handle_request(
        method=request.method,
        body=body,
        security_context=vars(security_context) if security_context else None,
    )
    return result


# ------------------------------------------------------------------
# API Key 管理
# ------------------------------------------------------------------

@router.get("/api/ai-ops/mcp/keys")
async def list_keys(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    keys = await mgr.list_keys()
    return {"success": True, "data": keys}


@router.post("/api/ai-ops/mcp/keys", status_code=201)
async def create_key(
    body: CreateKeyRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    if not body.tenant_id or not body.role or not body.label:
        raise HTTPException(400, "tenantId, role, and label are required")
    result = await mgr.create_key(body.tenant_id, body.role, body.label)
    return {"success": True, "data": result}


@router.delete("/api/ai-ops/mcp/keys/{key_id}")
async def revoke_key(
    key_id: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    try:
        await mgr.revoke_key(key_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    return {"success": True, "message": f"Key revoked: {key_id}"}


# ------------------------------------------------------------------
# MCP Server 状态
# ------------------------------------------------------------------

@router.get("/api/ai-ops/mcp/server/status")
async def server_status(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    handler = _get_mcp_server(request)
    return {
        "success": True,
        "status": {
            "enabled": handler is not None,
            "serverName": handler.server_name if handler else "opsevo-mcp-server",
            "version": handler.server_version if handler else "1.0.0",
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "tools": handler.get_tool_names() if handler else [],
        },
    }


# ------------------------------------------------------------------
# MCP Client 管理
# ------------------------------------------------------------------

@router.get("/api/ai-ops/mcp/client/servers")
async def list_client_servers(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    client = _get_mcp_client(request)
    if not client:
        return {"success": True, "data": []}
    status = client.get_connection_status()
    return {"success": True, "data": status}


@router.post("/api/ai-ops/mcp/client/servers", status_code=201)
async def add_client_server(
    body: AddServerRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    client = _get_mcp_client(request)
    if not client:
        raise HTTPException(503, "McpClientManager not available")
    from opsevo.services.mcp.client_manager import McpServerConfig

    config = McpServerConfig(
        server_id=body.server_id,
        name=body.name,
        transport=body.transport,
        enabled=body.enabled,
        connection_params=body.connection_params,
        oauth=body.oauth,
    )
    await client.connect_server(config)
    return {"success": True, "data": {"serverId": body.server_id, "status": "connecting"}}


@router.delete("/api/ai-ops/mcp/client/servers/{server_id}")
async def remove_client_server(
    server_id: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    client = _get_mcp_client(request)
    if not client:
        raise HTTPException(503, "McpClientManager not available")
    await client.disconnect_server(server_id)
    return {"success": True, "message": f"Server disconnected: {server_id}"}


@router.get("/api/ai-ops/mcp/client/status")
async def client_status(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    client = _get_mcp_client(request)
    if not client:
        return {"success": True, "data": {"connected": 0, "servers": []}}
    status = client.get_connection_status()
    connected = len([s for s in status if s["status"] == "connected"])
    return {"success": True, "data": {"connected": connected, "servers": status}}


# ------------------------------------------------------------------
# 工具列表
# ------------------------------------------------------------------

@router.get("/api/ai-ops/mcp/tools")
async def list_tools(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    registry = _get_tool_registry(request)
    if not registry:
        return {"success": True, "data": []}
    tools = registry.get_all_tools()
    return {
        "success": True,
        "data": [
            {
                "name": t.name,
                "description": t.description,
                "source": t.source,
                "serverId": t.server_id,
            }
            for t in tools
        ],
    }


# ------------------------------------------------------------------
# API Key 别名路由（前端 aiops-enhanced.ts 调用 /ai-ops/api-keys）
# ------------------------------------------------------------------

@router.get("/api/ai-ops/api-keys")
async def list_api_keys_alias(
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    keys = await mgr.list_keys()
    return {"success": True, "data": keys}


@router.post("/api/ai-ops/api-keys", status_code=201)
async def create_api_key_alias(
    body: CreateKeyRequest,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    result = await mgr.create_key(body.tenant_id, body.role, body.label)
    return {"success": True, "data": result}


@router.delete("/api/ai-ops/api-keys/{key_id}")
async def delete_api_key_alias(
    key_id: str,
    request: Request,
    _user: dict = Depends(get_current_user),
):
    mgr = _get_api_key_manager(request)
    if not mgr:
        raise HTTPException(503, "ApiKeyManager not available")
    try:
        await mgr.revoke_key(key_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    return {"success": True, "message": f"Key revoked: {key_id}"}
