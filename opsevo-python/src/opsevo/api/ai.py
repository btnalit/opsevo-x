"""
AI API 路由（全局）
/api/ai/* 端点

接入 ChatSessionService、AdapterPool、DataStore 真实逻辑。
所有 AI 功能为全局架构，不绑定特定设备。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .deps import get_current_user, get_datastore
from .utils import snake_to_camel, snake_to_camel_list

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _get_container(request: Request):
    return request.app.state.container


def _uid(user: dict[str, Any]) -> str:
    return str(user["id"])


async def _ensure_session_owned(ds, session_id: str, user_id: str) -> None:
    row = await ds.query_one(
        "SELECT id FROM chat_sessions WHERE id=$1 AND user_id=$2",
        [session_id, user_id],
    )
    if not row:
        raise HTTPException(404, "Session not found")


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
async def get_providers(request: Request, user=Depends(get_current_user)) -> dict:
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


# ==================== API 配置管理 ====================
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
        provider = row.get("provider", "")
        model = row.get("model") or row.get("model_name") or ""
        api_key = row.get("api_key") or ""
        base_url = row.get("base_url") or ""
        pool = _get_container(request).adapter_pool()
        adapter = await pool.get_adapter(provider, model=model, api_key=api_key, base_url=base_url)
        import time as _time
        t0 = _time.monotonic()
        await adapter.chat([{"role": "user", "content": "ping"}])
        latency = int((_time.monotonic() - t0) * 1000)
        return {
            "success": True,
            "message": "连接成功",
            "data": {
                "connected": True,
                "message": "API 可用",
                "latencyMs": latency,
                "latency_ms": latency,
            },
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"连接测试失败: {exc}",
            "data": {"connected": False, "message": str(exc)},
        }


# ==================== 聊天功能 ====================
@router.post("/chat")
async def chat(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    container = _get_container(request)
    agent = container.unified_agent()
    message = body.get("message", "")
    mode = body.get("mode", "general")
    session_id = body.get("sessionId")
    result = await agent.chat(
        message=message,
        mode=mode,
        session_id=session_id,
        user_id=_uid(user),
    )
    return {"success": True, "data": result}


# ==================== 聊天功能（SSE 流式） ====================
@router.post("/chat/stream")
async def chat_stream(
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
                user_id=_uid(user),
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
async def get_context(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    return {"success": True, "data": {}}


@router.get("/context/sections")
async def get_context_sections(user=Depends(get_current_user)) -> dict:
    sections = [
        {"id": "device_info", "name": "Device Information"},
        {"id": "interfaces", "name": "Network Interfaces"},
        {"id": "routing", "name": "Routing Table"},
        {"id": "firewall", "name": "Firewall Rules"},
        {"id": "system", "name": "System Resources"},
    ]
    return {"success": True, "data": sections}


@router.get("/context/sections/{section}")
async def get_context_section(section: str, request: Request, user=Depends(get_current_user)) -> dict:
    return {"success": True, "data": None}


# ==================== 脚本执行 ====================
@router.post("/scripts/execute")
async def execute_script(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    script = body.get("script", "")
    session_id = body.get("sessionId")
    device_id = body.get("deviceId", "")
    container = _get_container(request)
    pool = container.device_pool()
    if not device_id:
        return {"success": False, "error": "deviceId is required for script execution"}
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("run_script", {"script": script})
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
async def validate_script(request: Request, user=Depends(get_current_user)) -> dict:
    body = await request.json()
    script = body.get("script", "")
    valid = bool(script and len(script.strip()) > 0)
    return {"success": True, "data": {"valid": valid, "errors": [] if valid else ["Script is empty"]}}


@router.get("/scripts/history")
async def get_script_history(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM script_history ORDER BY timestamp DESC LIMIT 100")
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.delete("/scripts/history/session/{session_id}")
async def clear_session_script_history(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM script_history WHERE session_id=$1", [session_id])
    return {"success": True, "message": "Session script history cleared"}


@router.delete("/scripts/history/{history_id}")
async def delete_script_history(history_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM script_history WHERE id=$1", [history_id])
    return {"success": True, "message": "Script history deleted"}


# ==================== 会话管理 ====================
@router.get("/sessions/search")
async def search_sessions(q: str = Query(""), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    if q:
        rows = await ds.query(
            "SELECT * FROM chat_sessions WHERE user_id=$1 AND (title ILIKE $2 OR mode ILIKE $2) ORDER BY updated_at DESC",
            [user_id, f"%{q}%"],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC",
            [user_id],
        )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/sessions")
async def get_sessions(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC",
        [_uid(user)],
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.post("/sessions")
async def create_session(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    session = await svc.create_session(
        title=body.get("title", ""),
        mode=body.get("mode", "general"),
        user_id=_uid(user),
    )
    return {"success": True, "data": snake_to_camel(session)}


@router.delete("/sessions")
async def delete_all_sessions(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    await ds.execute(
        "DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id=$1)",
        [user_id],
    )
    count = await ds.execute(
        "DELETE FROM chat_sessions WHERE user_id=$1",
        [user_id],
    )
    return {"success": True, "message": f"Deleted {count} sessions"}


@router.get("/sessions/with-collections")
async def get_sessions_with_collections(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        """SELECT s.*, COUNT(cm.id) as collected_count
           FROM chat_sessions s
           LEFT JOIN chat_messages cm ON cm.session_id = s.id AND cm.collected = true
           WHERE s.user_id = $1
           GROUP BY s.id
           HAVING COUNT(cm.id) > 0
           ORDER BY s.updated_at DESC""",
        [_uid(user)],
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/sessions/{session_id}")
async def get_session_by_id(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    row = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2",
        [session_id, user_id],
    )
    if not row:
        raise HTTPException(404, "Session not found")
    messages = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id]
    )
    row["messages"] = snake_to_camel_list(messages or [])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/sessions/{session_id}")
async def update_session(session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    result = await svc.update_session(session_id, body, user_id=_uid(user))
    if not result:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": snake_to_camel(result)}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    await _ensure_session_owned(ds, session_id, user_id)
    await ds.execute("DELETE FROM chat_messages WHERE session_id=$1", [session_id])
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    deleted = await svc.delete_session(session_id, user_id=user_id)
    if not deleted:
        raise HTTPException(404, "Session not found")
    return {"success": True, "message": "Session deleted"}


@router.put("/sessions/{session_id}/rename")
async def rename_session(session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    title = body.get("title", "")
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    result = await svc.update_session(session_id, {"title": title}, user_id=_uid(user))
    if not result:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": snake_to_camel(result)}


@router.post("/sessions/{session_id}/clear")
async def clear_session_messages(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    await ds.execute("DELETE FROM chat_messages WHERE session_id=$1", [session_id])
    return {"success": True, "message": "Session messages cleared"}


@router.get("/sessions/{session_id}/export")
async def export_session(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    session = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2",
        [session_id, _uid(user)],
    )
    if not session:
        raise HTTPException(404, "Session not found")
    messages = await ds.query("SELECT role, content, created_at FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id])
    export_text = f"# {session.get('title', 'Chat Export')}\n\n"
    for msg in (messages or []):
        role = msg.get("role", "unknown").capitalize()
        content = msg.get("content", "")
        export_text += f"**{role}**: {content}\n\n"
    return {"success": True, "data": export_text}


@router.post("/sessions/{session_id}/duplicate")
async def duplicate_session(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    original = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2",
        [session_id, user_id],
    )
    if not original:
        raise HTTPException(404, "Session not found")
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    new_session = await svc.create_session(
        title=f"{original.get('title', 'Chat')} (copy)",
        mode=original.get("mode", "general"),
        user_id=user_id,
    )
    messages = await ds.query("SELECT role, content FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id])
    for msg in (messages or []):
        await svc.add_message(new_session["id"], msg["role"], msg["content"])
    return {"success": True, "data": snake_to_camel(new_session)}


# ==================== 会话配置管理 ====================
@router.get("/sessions/{session_id}/config")
async def get_session_config(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT config FROM chat_sessions WHERE id=$1 AND user_id=$2",
        [session_id, _uid(user)],
    )
    if not row:
        raise HTTPException(404, "Session not found")
    config = row.get("config") or {}
    if isinstance(config, str):
        import json as _json
        config = _json.loads(config)
    return {"success": True, "data": config}


@router.put("/sessions/{session_id}/config")
async def update_session_config(session_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    user_id = _uid(user)
    await _ensure_session_owned(ds, session_id, user_id)
    body = await request.json()
    import json as _json
    config_json = _json.dumps(body)
    rows = await ds.execute(
        "UPDATE chat_sessions SET config=$1 WHERE id=$2 AND user_id=$3",
        [config_json, session_id, user_id],
    )
    if rows == 0:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": body}


@router.get("/sessions/{session_id}/context-stats")
async def get_context_stats(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
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
async def get_context_messages(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    messages = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", [session_id]
    )
    return {"success": True, "data": snake_to_camel_list(messages or [])}


# ==================== 对话收藏管理 ====================
@router.post("/sessions/{session_id}/messages/{message_id}/collect")
async def collect_message(session_id: str, message_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=true WHERE id=$1 AND session_id=$2", [message_id, session_id]
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message collected"}


@router.delete("/sessions/{session_id}/messages/{message_id}/collect")
async def uncollect_message(session_id: str, message_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=false WHERE id=$1 AND session_id=$2", [message_id, session_id]
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message uncollected"}


@router.get("/sessions/{session_id}/collected")
async def get_collected_messages(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    rows = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC", [session_id]
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/sessions/{session_id}/collected/export")
async def export_collected_messages(session_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await _ensure_session_owned(ds, session_id, _uid(user))
    rows = await ds.query(
        "SELECT role, content FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC",
        [session_id],
    )
    export_text = "\n\n".join(f"**{r['role'].capitalize()}**: {r['content']}" for r in (rows or []))
    return {"success": True, "data": export_text}


# ==================== 对话转知识库 ====================
@router.post("/conversations/convert")
async def convert_to_knowledge(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    message_ids = body.get("messageIds", [])
    title = body.get("title", "Converted from chat")
    tags = body.get("tags", [])
    if not message_ids:
        raise HTTPException(400, "messageIds required")
    placeholders = ", ".join(f"${i+1}" for i in range(len(message_ids)))
    user_id = _uid(user)
    messages = await ds.query(
        f"""SELECT cm.role, cm.content
            FROM chat_messages cm
            JOIN chat_sessions cs ON cs.id = cm.session_id
            WHERE cm.id IN ({placeholders}) AND cs.user_id = ${len(message_ids) + 1}
            ORDER BY cm.created_at ASC""",
        [*message_ids, user_id],
    )
    if len(messages or []) != len(set(message_ids)):
        raise HTTPException(404, "Some messages not found")
    content = "\n\n".join(f"{m['role']}: {m['content']}" for m in messages)
    container = _get_container(request)
    kb = container.knowledge_base()
    doc_id = await kb.add_entry(content=content, metadata={"title": title, "source": "chat_conversion"}, tags=tags)
    return {"success": True, "data": {"id": doc_id, "title": title}}


@router.post("/conversations/batch-convert")
async def batch_convert_to_knowledge(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    items = body.get("items", [])
    results = []
    container = _get_container(request)
    kb = container.knowledge_base()
    user_id = _uid(user)
    for item in items:
        message_ids = item.get("messageIds", [])
        title = item.get("title", "Converted from chat")
        tags = item.get("tags", [])
        if not message_ids:
            continue
        placeholders = ", ".join(f"${i+1}" for i in range(len(message_ids)))
        messages = await ds.query(
            f"""SELECT cm.role, cm.content
                FROM chat_messages cm
                JOIN chat_sessions cs ON cs.id = cm.session_id
                WHERE cm.id IN ({placeholders}) AND cs.user_id = ${len(message_ids) + 1}
                ORDER BY cm.created_at ASC""",
            [*message_ids, user_id],
        )
        if len(messages or []) != len(set(message_ids)):
            raise HTTPException(404, "Some messages not found")
        content = "\n\n".join(f"{m['role']}: {m['content']}" for m in messages)
        doc_id = await kb.add_entry(content=content, metadata={"title": title, "source": "chat_conversion"}, tags=tags)
        results.append({"id": doc_id, "title": title})
    return {"success": True, "data": results}


@router.post("/conversations/suggest-tags")
async def suggest_tags(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    content = body.get("content", "")
    words = content.lower().split()
    common_tags = {"network", "firewall", "routing", "interface", "vpn", "dns", "dhcp",
                   "security", "performance", "monitoring", "backup", "config"}
    suggested = [w for w in set(words) if w in common_tags][:5]
    return {"success": True, "data": suggested}


# ==================== 收藏消息（兼容前端 /chat/favorites 契约） ====================
@router.get("/chat/favorites")
async def get_favorites(
    search: str | None = Query(None),
    sessionId: str | None = Query(None, alias="sessionId"),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Return all collected/favorited messages across sessions."""
    base = """
        SELECT cm.id, cm.role, cm.content, cm.session_id, cm.created_at,
               cs.title AS session_title
        FROM chat_messages cm
        JOIN chat_sessions cs ON cs.id = cm.session_id
        WHERE cm.collected = true AND cs.user_id = $1
    """
    params: list[Any] = [_uid(user)]
    idx = 2

    if sessionId:
        base += f" AND cm.session_id = ${idx}"
        params.append(sessionId)
        idx += 1

    if search:
        base += f" AND cm.content ILIKE ${idx}"
        params.append(f"%{search}%")
        idx += 1

    base += " ORDER BY cm.created_at DESC"

    rows = await ds.query(base, params)
    data = [
        {
            "id": str(r["id"]),
            "content": r["content"],
            "role": r["role"],
            "sessionId": str(r["session_id"]),
            "sessionTitle": r.get("session_title") or "",
            "collectedAt": r["created_at"].isoformat() if r.get("created_at") else "",
            "converted": False,
        }
        for r in (rows or [])
    ]
    return {"success": True, "data": data}


@router.delete("/chat/favorites/{message_id}")
async def remove_favorite(
    message_id: str,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Uncollect a message by its ID (across all sessions)."""
    user_id = _uid(user)
    rows = await ds.execute(
        """UPDATE chat_messages cm
           SET collected=false
           WHERE cm.id=$1 AND cm.collected=true
             AND EXISTS (
               SELECT 1 FROM chat_sessions cs
               WHERE cs.id = cm.session_id AND cs.user_id = $2
             )""",
        [message_id, user_id],
    )
    if rows == 0:
        raise HTTPException(404, "Favorite message not found")
    return {"success": True, "message": "Favorite removed"}


@router.get("/chat/sessions")
async def get_chat_sessions_alias(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Alias for /sessions — used by FavoriteMessages page."""
    rows = await ds.query(
        "SELECT * FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC",
        [_uid(user)],
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}
