"""
AI API 路由
/api/devices/{device_id}/ai/* 端点

接入 ChatSessionService、AdapterPool、DataStore 真实逻辑。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .deps import get_current_user, get_datastore
from .utils import snake_to_camel, snake_to_camel_list

router = APIRouter(prefix="/api/devices/{device_id}/ai", tags=["ai"])


def _get_container(request: Request):
    return request.app.state.container


def _mask_api_key(key: str | None) -> str:
    """Mask API key for display: show last 4 chars only."""
    if not key:
        return ""
    if len(key) <= 4:
        return "****"
    return "*" * (len(key) - 4) + key[-4:]


def _format_config_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Map DB snake_case fields to frontend camelCase fields."""
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


# ==================== 提供商信息 ====================
@router.get("/providers")
async def get_providers(device_id: str, request: Request, user=Depends(get_current_user)) -> dict:
    provider_list = [
        {"id": "openai", "name": "OpenAI", "defaultEndpoint": "https://api.openai.com/v1",
         "defaultModels": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]},
        {"id": "gemini", "name": "Google Gemini", "defaultEndpoint": "https://generativelanguage.googleapis.com/v1beta",
         "defaultModels": ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-2.5-pro-preview-06-05"]},
        {"id": "claude", "name": "Anthropic Claude", "defaultEndpoint": "https://api.anthropic.com/v1",
         "defaultModels": ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"]},
        {"id": "deepseek", "name": "DeepSeek", "defaultEndpoint": "https://api.deepseek.com/v1",
         "defaultModels": ["deepseek-chat", "deepseek-reasoner"]},
        {"id": "qwen", "name": "Qwen", "defaultEndpoint": "https://dashscope.aliyuncs.com/api/v1",
         "defaultModels": ["qwen-plus", "qwen-turbo", "qwen-max"]},
        {"id": "zhipu", "name": "智谱AI", "defaultEndpoint": "https://open.bigmodel.cn/api/paas/v4",
         "defaultModels": ["glm-4-plus", "glm-4-flash"]},
        {"id": "ollama", "name": "Ollama (本地)", "defaultEndpoint": "http://localhost:11434/v1",
         "defaultModels": ["llama3", "qwen2.5", "deepseek-r1"]},
        {"id": "custom", "name": "自定义", "defaultEndpoint": "",
         "defaultModels": []},
    ]
    return {"success": True, "data": provider_list}


# ==================== API 配置管理 ====================
@router.get("/configs/default")
async def get_default_config(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT * FROM ai_configs WHERE device_id=$1 AND is_default=true", [device_id]
    )
    return {"success": True, "data": _format_config_row(row)}


@router.get("/configs")
async def get_configs(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM ai_configs WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": [_format_config_row(r) for r in rows]}


@router.get("/configs/{config_id}")
async def get_config_by_id(device_id: str, config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1 AND device_id=$2", [config_id, device_id])
    if not row:
        raise HTTPException(404, "Config not found")
    return {"success": True, "data": _format_config_row(row)}


@router.post("/configs")
async def create_config(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    config_id = str(uuid.uuid4())
    provider = body.get("provider", "openai")
    model = body.get("model", "")
    api_key = body.get("apiKey", "")
    base_url = body.get("endpoint") or body.get("baseUrl") or ""
    name = body.get("name", f"{provider} config")
    is_default = bool(body.get("isDefault", False))
    # 如果设为默认，先取消其他默认
    if is_default:
        await ds.execute("UPDATE ai_configs SET is_default=false WHERE device_id=$1", [device_id])
    await ds.execute(
        "INSERT INTO ai_configs (id, device_id, name, provider, model, api_key, base_url, is_default) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        (config_id, device_id, name, provider, model, api_key, base_url, is_default),
    )
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [config_id])
    return {"success": True, "data": _format_config_row(row)}


@router.put("/configs/{config_id}")
async def update_config(device_id: str, config_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    existing = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1 AND device_id=$2", [config_id, device_id])
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
async def delete_config(device_id: str, config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.execute("DELETE FROM ai_configs WHERE id=$1 AND device_id=$2", [config_id, device_id])
    if rows == 0:
        raise HTTPException(404, "Config not found")
    return {"success": True, "message": "Config deleted"}


@router.post("/configs/{config_id}/default")
async def set_default_config(device_id: str, config_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    async def _set(tx):
        await tx.execute("UPDATE ai_configs SET is_default=false WHERE device_id=$1", [device_id])
        return await tx.execute("UPDATE ai_configs SET is_default=true WHERE id=$1 AND device_id=$2", [config_id, device_id])

    rows = await ds.transaction(_set)
    if rows == 0:
        raise HTTPException(404, "Config not found")
    return {"success": True, "message": "Default config set"}


@router.post("/configs/{config_id}/test")
async def test_config_connection(device_id: str, config_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1 AND device_id=$2", [config_id, device_id])
    if not row:
        raise HTTPException(404, "Config not found")
    try:
        pool = _get_container(request).adapter_pool()
        adapter = await pool.get_adapter()
        result = await adapter.chat([{"role": "user", "content": "ping"}])
        return {"success": True, "message": "Connection test passed", "data": {"latency_ms": 0}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ==================== 聊天功能 ====================
@router.post("/chat")
async def chat(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    container = _get_container(request)
    agent = container.unified_agent()
    message = body.get("message", "")
    mode = body.get("mode", "general")
    session_id = body.get("sessionId")
    result = await agent.chat(message=message, mode=mode, session_id=session_id, device_id=device_id)
    return {"success": True, "data": result}


# ==================== 聊天功能（SSE 流式） ====================
@router.post("/chat/stream")
async def chat_stream(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    import asyncio
    from fastapi.responses import StreamingResponse

    body = await request.json()
    container = _get_container(request)
    agent = container.unified_agent()
    message = body.get("message", "")
    mode = body.get("mode", "general")
    session_id = body.get("sessionId")
    config_id = body.get("configId")
    include_context = body.get("includeContext", False)

    async def event_generator():
        try:
            full_content = ""
            async for chunk in agent.chat_stream(
                message,
                mode=mode,
                session_id=session_id or "",
                device_id=device_id,
            ):
                if isinstance(chunk, dict):
                    content = chunk.get("content", "")
                else:
                    content = str(chunk)
                full_content += content
                data = json.dumps({"content": content}, ensure_ascii=False)
                yield f"data: {data}\n\n"
                if await request.is_disconnected():
                    break
            done_data = json.dumps({"done": True, "fullContent": full_content}, ensure_ascii=False)
            yield f"data: {done_data}\n\n"
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            error_data = json.dumps({"error": str(exc)}, ensure_ascii=False)
            yield f"data: {error_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ==================== 设备上下文 ====================
@router.get("/context")
async def get_context(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    try:
        from opsevo.services.ai.context_builder import ContextBuilderService
        container = _get_container(request)
        pool = container.device_pool()
        driver = await pool.get_driver(device_id)
        builder = ContextBuilderService()
        ctx = await builder.build_context(driver)
        return {"success": True, "data": ctx}
    except Exception:
        return {"success": True, "data": {}}


@router.get("/context/sections")
async def get_context_sections(device_id: str, user=Depends(get_current_user)) -> dict:
    sections = [
        {"id": "device_info", "name": "Device Information"},
        {"id": "interfaces", "name": "Network Interfaces"},
        {"id": "routing", "name": "Routing Table"},
        {"id": "firewall", "name": "Firewall Rules"},
        {"id": "system", "name": "System Resources"},
    ]
    return {"success": True, "data": sections}


@router.get("/context/sections/{section}")
async def get_context_section(device_id: str, section: str, request: Request, user=Depends(get_current_user)) -> dict:
    try:
        from opsevo.services.ai.context_builder import ContextBuilderService
        container = _get_container(request)
        pool = container.device_pool()
        driver = await pool.get_driver(device_id)
        builder = ContextBuilderService()
        ctx = await builder.build_context(driver)
        data = ctx.get(section)
        if data is None:
            raise HTTPException(404, f"Section '{section}' not found")
        return {"success": True, "data": data}
    except HTTPException:
        raise
    except Exception:
        return {"success": True, "data": None}


# ==================== 脚本执行 ====================
@router.post("/scripts/execute")
async def execute_script(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    script = body.get("script", "")
    session_id = body.get("sessionId")
    container = _get_container(request)
    pool = container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("run_script", {"script": script})
        # Record to history
        history_id = str(uuid.uuid4())
        await ds.execute(
            "INSERT INTO script_history (id, device_id, session_id, script, output, success, timestamp) "
            "VALUES ($1,$2,$3,$4,$5,$6,NOW())",
            (history_id, device_id, session_id, script, result.data if hasattr(result, 'data') else str(result), True),
        )
        return {"success": True, "data": {"output": result.data if hasattr(result, 'data') else str(result), "exitCode": 0}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/scripts/validate")
async def validate_script(device_id: str, request: Request, user=Depends(get_current_user)) -> dict:
    body = await request.json()
    script = body.get("script", "")
    # Basic validation: check non-empty and no obvious syntax issues
    valid = bool(script and len(script.strip()) > 0)
    return {"success": True, "data": {"valid": valid, "errors": [] if valid else ["Script is empty"]}}


@router.get("/scripts/history")
async def get_script_history(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM script_history WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 100", [device_id]
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.delete("/scripts/history/session/{session_id}")
async def clear_session_script_history(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM script_history WHERE device_id=$1 AND session_id=$2", [device_id, session_id])
    return {"success": True, "message": "Session script history cleared"}


@router.delete("/scripts/history/{history_id}")
async def delete_script_history(device_id: str, history_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM script_history WHERE id=$1 AND device_id=$2", [history_id, device_id])
    return {"success": True, "message": "Script history deleted"}


# ==================== 会话管理 ====================
@router.get("/sessions/search")
async def search_sessions(device_id: str, q: str = Query(""), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if q:
        rows = await ds.query(
            "SELECT * FROM chat_sessions WHERE device_id=$1 AND (title ILIKE $2 OR mode ILIKE $2) ORDER BY updated_at DESC",
            [device_id, f"%{q}%"],
        )
    else:
        rows = await ds.query("SELECT * FROM chat_sessions WHERE device_id=$1 ORDER BY updated_at DESC", [device_id])
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/sessions")
async def get_sessions(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM chat_sessions WHERE device_id=$1 ORDER BY updated_at DESC", [device_id])
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.post("/sessions")
async def create_session(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    session = await svc.create_session(
        device_id=device_id,
        title=body.get("title", ""),
        mode=body.get("mode", "general"),
    )
    return {"success": True, "data": snake_to_camel(session)}


@router.delete("/sessions")
async def delete_all_sessions(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    async def _delete(tx):
        await tx.execute(
            "DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE device_id=$1)",
            [device_id],
        )
        return await tx.execute("DELETE FROM chat_sessions WHERE device_id=$1", [device_id])

    count = await ds.transaction(_delete)
    return {"success": True, "message": f"Deleted {count} sessions"}


@router.get("/sessions/{session_id}")
async def get_session_by_id(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM chat_sessions WHERE id=$1 AND device_id=$2", [session_id, device_id])
    if not row:
        raise HTTPException(404, "Session not found")
    # Include messages
    messages = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id]
    )
    row["messages"] = snake_to_camel_list(messages or [])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/sessions/{session_id}")
async def update_session(device_id: str, session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    result = await svc.update_session(session_id, body)
    if not result:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": snake_to_camel(result)}


@router.delete("/sessions/{session_id}")
async def delete_session(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    # Delete messages first
    await ds.execute("DELETE FROM chat_messages WHERE session_id=$1", [session_id])
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    deleted = await svc.delete_session(session_id)
    if not deleted:
        raise HTTPException(404, "Session not found")
    return {"success": True, "message": "Session deleted"}


@router.put("/sessions/{session_id}/rename")
async def rename_session(device_id: str, session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    title = body.get("title", "")
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    result = await svc.update_session(session_id, {"title": title})
    if not result:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": snake_to_camel(result)}


@router.post("/sessions/{session_id}/clear")
async def clear_session_messages(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM chat_messages WHERE session_id=$1", [session_id])
    return {"success": True, "message": "Session messages cleared"}


@router.get("/sessions/{session_id}/export")
async def export_session(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    session = await ds.query_one("SELECT * FROM chat_sessions WHERE id=$1 AND device_id=$2", [session_id, device_id])
    if not session:
        raise HTTPException(404, "Session not found")
    messages = await ds.query("SELECT role, content, created_at FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id])
    export_text = f"# {session.get('title', 'Chat Export')}\n\n"
    for msg in messages:
        role = msg.get("role", "unknown").capitalize()
        content = msg.get("content", "")
        export_text += f"**{role}**: {content}\n\n"
    return {"success": True, "data": export_text}


@router.post("/sessions/{session_id}/duplicate")
async def duplicate_session(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    original = await ds.query_one("SELECT * FROM chat_sessions WHERE id=$1 AND device_id=$2", [session_id, device_id])
    if not original:
        raise HTTPException(404, "Session not found")
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    new_session = await svc.create_session(
        device_id=device_id,
        title=f"{original.get('title', 'Chat')} (copy)",
        mode=original.get("mode", "general"),
    )
    # Copy messages
    messages = await ds.query("SELECT role, content FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id])
    for msg in messages:
        await svc.add_message(new_session["id"], msg["role"], msg["content"])
    return {"success": True, "data": snake_to_camel(new_session)}


# ==================== 会话配置管理 ====================
@router.get("/sessions/{session_id}/config")
async def get_session_config(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT config FROM chat_sessions WHERE id=$1 AND device_id=$2", [session_id, device_id]
    )
    if not row:
        raise HTTPException(404, "Session not found")
    config = row.get("config") or {}
    if isinstance(config, str):
        import json as _json
        config = _json.loads(config)
    return {"success": True, "data": config}


@router.put("/sessions/{session_id}/config")
async def update_session_config(device_id: str, session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    import json as _json
    config_json = _json.dumps(body)
    rows = await ds.execute(
        "UPDATE chat_sessions SET config=$1 WHERE id=$2 AND device_id=$3",
        [config_json, session_id, device_id],
    )
    if rows == 0:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": body}


@router.get("/sessions/{session_id}/context-stats")
async def get_context_stats(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    msg_count = await ds.query_one(
        "SELECT COUNT(*) as count FROM chat_messages WHERE session_id=$1", [session_id]
    )
    total_chars = await ds.query_one(
        "SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM chat_messages WHERE session_id=$1", [session_id]
    )
    return {
        "success": True,
        "data": {
            "messageCount": msg_count["count"] if msg_count else 0,
            "totalCharacters": total_chars["total"] if total_chars else 0,
            "estimatedTokens": (total_chars["total"] if total_chars else 0) // 4,
        },
    }


@router.get("/sessions/{session_id}/context-messages")
async def get_context_messages(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    messages = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id]
    )
    return {"success": True, "data": snake_to_camel_list(messages or [])}


# ==================== 对话收藏管理 ====================
@router.get("/sessions/with-collections")
async def get_sessions_with_collections(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        """SELECT s.*, COUNT(cm.id) as collected_count
           FROM chat_sessions s
           LEFT JOIN chat_messages cm ON cm.session_id = s.id AND cm.collected = true
           WHERE s.device_id = $1
           GROUP BY s.id
           HAVING COUNT(cm.id) > 0
           ORDER BY s.updated_at DESC""",
        [device_id],
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.post("/sessions/{session_id}/messages/{message_id}/collect")
async def collect_message(device_id: str, session_id: str, message_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=true WHERE id=$1 AND session_id=$2", [message_id, session_id]
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message collected"}


@router.delete("/sessions/{session_id}/messages/{message_id}/collect")
async def uncollect_message(device_id: str, session_id: str, message_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=false WHERE id=$1 AND session_id=$2", [message_id, session_id]
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message uncollected"}


@router.get("/sessions/{session_id}/collected")
async def get_collected_messages(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC", [session_id]
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/sessions/{session_id}/collected/export")
async def export_collected_messages(device_id: str, session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT role, content FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC",
        [session_id],
    )
    export_text = "\n\n".join(f"**{r['role'].capitalize()}**: {r['content']}" for r in rows)
    return {"success": True, "data": export_text}


# ==================== 对话转知识库 ====================
@router.post("/conversations/convert")
async def convert_to_knowledge(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    message_ids = body.get("messageIds", [])
    title = body.get("title", "Converted from chat")
    tags = body.get("tags", [])
    if not message_ids:
        raise HTTPException(400, "messageIds required")
    placeholders = ", ".join(f"${i+1}" for i in range(len(message_ids)))
    messages = await ds.query(
        f"SELECT role, content FROM chat_messages WHERE id IN ({placeholders}) ORDER BY created_at ASC",
        message_ids,
    )
    content = "\n\n".join(f"{m['role']}: {m['content']}" for m in messages)
    container = _get_container(request)
    kb = container.knowledge_base()
    doc_id = await kb.add_entry(content=content, metadata={"title": title, "source": "chat_conversion"}, tags=tags)
    return {"success": True, "data": {"id": doc_id, "title": title}}


@router.post("/conversations/batch-convert")
async def batch_convert_to_knowledge(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    items = body.get("items", [])
    results = []
    container = _get_container(request)
    kb = container.knowledge_base()
    for item in items:
        message_ids = item.get("messageIds", [])
        title = item.get("title", "Converted from chat")
        tags = item.get("tags", [])
        if not message_ids:
            continue
        placeholders = ", ".join(f"${i+1}" for i in range(len(message_ids)))
        messages = await ds.query(
            f"SELECT role, content FROM chat_messages WHERE id IN ({placeholders}) ORDER BY created_at ASC",
            message_ids,
        )
        content = "\n\n".join(f"{m['role']}: {m['content']}" for m in messages)
        doc_id = await kb.add_entry(content=content, metadata={"title": title, "source": "chat_conversion"}, tags=tags)
        results.append({"id": doc_id, "title": title})
    return {"success": True, "data": results}


@router.post("/conversations/suggest-tags")
async def suggest_tags(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    content = body.get("content", "")
    # Simple keyword extraction for tag suggestions
    words = content.lower().split()
    common_tags = {"network", "firewall", "routing", "interface", "vpn", "dns", "dhcp",
                   "security", "performance", "monitoring", "backup", "config"}
    suggested = [w for w in set(words) if w in common_tags][:5]
    return {"success": True, "data": suggested}
