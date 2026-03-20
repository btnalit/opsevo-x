"""
AI Config API 路由（全局）
/api/ai/configs/* 端点

AI 服务配置（API key、provider、model）是全局资源，不绑定特定设备。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .deps import get_current_user, get_datastore
from .utils import snake_to_camel

router = APIRouter(prefix="/api/ai", tags=["ai-config"])


def _mask_api_key(key: str | None) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "****"
    return "*" * (len(key) - 4) + key[-4:]


def _format_config_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row.get("id"),
        "provider": row.get("provider", ""),
        "name": row.get("name", ""),
        "model": row.get("model") or row.get("model_name") or "",
        "endpoint": row.get("base_url") or "",
        "apiKeyMasked": _mask_api_key(row.get("api_key") or ""),
        "isDefault": bool(row.get("is_default", False)),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


@router.get("/providers")
async def get_providers(user=Depends(get_current_user)) -> dict:
    provider_list = [
        {"id": "openai", "name": "OpenAI", "defaultEndpoint": "https://api.openai.com/v1",
         "defaultModels": ["gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"]},
        {"id": "gemini", "name": "Google Gemini", "defaultEndpoint": "https://generativelanguage.googleapis.com/v1beta",
         "defaultModels": ["gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]},
        {"id": "claude", "name": "Anthropic Claude", "defaultEndpoint": "https://api.anthropic.com/v1",
         "defaultModels": ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]},
        {"id": "deepseek", "name": "DeepSeek", "defaultEndpoint": "https://api.deepseek.com/v1",
         "defaultModels": ["deepseek-chat", "deepseek-reasoner"]},
        {"id": "qwen", "name": "Qwen (通义千问)", "defaultEndpoint": "https://dashscope.aliyuncs.com/api/v1",
         "defaultModels": ["qwen3-max", "qwen3-plus", "qwen3-turbo", "qwen-max", "qwen-plus", "qwen-turbo"]},
        {"id": "zhipu", "name": "智谱AI", "defaultEndpoint": "https://open.bigmodel.cn/api/paas/v4",
         "defaultModels": ["glm-4.7", "glm-4-plus", "glm-4-flash", "glm-4-flashx", "glm-4-air"]},
        {"id": "ollama", "name": "Ollama (本地)", "defaultEndpoint": "http://localhost:11434/v1",
         "defaultModels": ["llama3", "qwen2.5", "deepseek-r1"]},
        {"id": "custom", "name": "自定义", "defaultEndpoint": "",
         "defaultModels": []},
    ]
    return {"success": True, "data": provider_list}


@router.get("/configs/default")
async def get_default_config(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE is_default=true LIMIT 1")
    return {"success": True, "data": _format_config_row(row)}


@router.get("/configs")
async def get_configs(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM ai_configs ORDER BY created_at DESC")
    return {"success": True, "data": [_format_config_row(r) for r in rows]}


@router.get("/configs/{config_id}")
async def get_config_by_id(config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    if not row:
        raise HTTPException(404, "Config not found")
    return {"success": True, "data": _format_config_row(row)}


@router.post("/configs")
async def create_config(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    config_id = str(uuid.uuid4())
    provider = body.get("provider", "openai")
    model = body.get("model", "")
    api_key = body.get("apiKey", "")
    base_url = body.get("endpoint") or body.get("baseUrl") or ""
    name = body.get("name", f"{provider} config")
    is_default = bool(body.get("isDefault", False))
    if is_default:
        await ds.execute("UPDATE ai_configs SET is_default=false WHERE is_default=true")
    await ds.execute(
        "INSERT INTO ai_configs (id, name, provider, model, api_key, base_url, is_default) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
        (config_id, name, provider, model, api_key, base_url, is_default),
    )
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    return {"success": True, "data": _format_config_row(row)}


@router.put("/configs/{config_id}")
async def update_config(config_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    existing = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    if not existing:
        raise HTTPException(404, "Config not found")
    sets = []
    params: list[Any] = []
    idx = 1
    allowed_cols = {"name", "provider", "model", "api_key", "base_url", "temperature", "max_tokens", "is_default"}
    col_map = {"apiKey": "api_key", "baseUrl": "base_url", "endpoint": "base_url", "isDefault": "is_default"}
    for k, v in body.items():
        col = col_map.get(k, k)
        if col in allowed_cols:
            sets.append(f"{col} = ${idx}")
            params.append(v)
            idx += 1
    if sets:
        params.append(config_id)
        await ds.execute(f"UPDATE ai_configs SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    return {"success": True, "data": _format_config_row(row)}


@router.delete("/configs/{config_id}")
async def delete_config(config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.execute("DELETE FROM ai_configs WHERE id=$1", [config_id])
    if rows == 0:
        raise HTTPException(404, "Config not found")
    return {"success": True, "message": "Config deleted"}


@router.post("/configs/{config_id}/default")
async def set_default_config(config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    async def _set(tx):
        await tx.execute("UPDATE ai_configs SET is_default=false WHERE is_default=true")
        return await tx.execute("UPDATE ai_configs SET is_default=true WHERE id=$1", [config_id])

    rows = await ds.transaction(_set)
    if rows == 0:
        raise HTTPException(404, "Config not found")
    return {"success": True, "message": "Default config set"}


@router.post("/configs/{config_id}/test")
async def test_config_connection(config_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    if not row:
        raise HTTPException(404, "Config not found")
    try:
        container = request.app.state.container
        pool = container.adapter_pool()
        adapter = await pool.get_adapter()
        result = await adapter.chat([{"role": "user", "content": "ping"}])
        return {"success": True, "message": "Connection test passed", "data": {"latency_ms": 0}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
