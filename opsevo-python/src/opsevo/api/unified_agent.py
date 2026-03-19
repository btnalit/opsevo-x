"""Unified Agent API routes.

Provides all /api/devices/{device_id}/ai/unified/* endpoints:
- chat (stream + sync)
- sessions CRUD
- scripts execute (stream + sync)
- execution history
- message collection / knowledge conversion

Requirements: 4.1, 4.2, 4.3
"""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from opsevo.api.deps import get_current_user, get_datastore
from opsevo.models.ai import ChatRequest

router = APIRouter(
    prefix="/api/devices/{device_id}/ai/unified",
    tags=["unified-agent"],
)


def _c(request: Request):
    return request.app.state.container


def _agent(request: Request):
    provider = getattr(_c(request), "unified_agent", None)
    if provider is None:
        raise HTTPException(503, "Unified agent service not available")
    return provider()


# ==================== Chat ====================

@router.post("/chat/stream")
async def chat_stream(
    device_id: str,
    body: ChatRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    agent = _agent(request)

    async def event_generator():
        try:
            async for chunk in agent.chat_stream(
                body.message,
                mode=body.mode,
                session_id=body.session_id or "",
                device_id=device_id,
            ):
                data = json.dumps(chunk, ensure_ascii=False)
                yield f"data: {data}\n\n"
                if await request.is_disconnected():
                    break
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            error_data = json.dumps({"type": "error", "content": str(exc)})
            yield f"data: {error_data}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat")
async def chat(
    device_id: str,
    body: ChatRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    agent = _agent(request)
    result = await agent.chat(
        body.message,
        mode=body.mode,
        session_id=body.session_id or "",
        device_id=device_id,
    )
    return {"success": True, "data": result}


# ==================== Sessions ====================

@router.get("/sessions")
async def get_sessions(
    device_id: str,
    mode: str | None = Query(None),
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    if mode:
        rows = await ds.query(
            "SELECT * FROM chat_sessions WHERE device_id=$1 AND mode=$2 ORDER BY updated_at DESC",
            [device_id, mode],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM chat_sessions WHERE device_id=$1 ORDER BY updated_at DESC",
            [device_id],
        )
    return {"success": True, "data": rows}


@router.post("/sessions")
async def create_session(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    session = await svc.create_session(
        device_id=device_id,
        title=body.get("title", ""),
        mode=body.get("mode", "standard"),
    )
    return {"success": True, "data": session}


@router.get("/sessions-with-collections")
async def get_sessions_with_collections(
    device_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
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
    return {"success": True, "data": rows}


@router.get("/sessions/{session_id}")
async def get_session(
    device_id: str,
    session_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    row = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND device_id=$2",
        [session_id, device_id],
    )
    if not row:
        raise HTTPException(404, "Session not found")
    messages = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC",
        [session_id],
    )
    row["messages"] = messages
    return {"success": True, "data": row}


@router.put("/sessions/{session_id}")
async def update_session(
    device_id: str,
    session_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    result = await svc.update_session(session_id, body)
    if not result:
        raise HTTPException(404, "Session not found")
    return {"success": True, "data": result}


@router.delete("/sessions/{session_id}")
async def delete_session(
    device_id: str,
    session_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    await ds.execute("DELETE FROM chat_messages WHERE session_id=$1", [session_id])
    from opsevo.services.ai.chat_session import ChatSessionService
    svc = ChatSessionService(ds)
    deleted = await svc.delete_session(session_id)
    if not deleted:
        raise HTTPException(404, "Session not found")
    return {"success": True, "message": "Session deleted"}


@router.get("/sessions/{session_id}/export")
async def export_session(
    device_id: str,
    session_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    session = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND device_id=$2",
        [session_id, device_id],
    )
    if not session:
        raise HTTPException(404, "Session not found")
    messages = await ds.query(
        "SELECT role, content, created_at FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC",
        [session_id],
    )
    export_text = f"# {session.get('title', 'Chat Export')}\n\n"
    for msg in messages:
        role = msg.get("role", "unknown").capitalize()
        content = msg.get("content", "")
        export_text += f"**{role}**: {content}\n\n"
    return {"success": True, "data": export_text}


# ==================== Scripts ====================

@router.post("/scripts/execute")
async def execute_script(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    script = body.get("script", "")
    session_id = body.get("sessionId")
    analyze = body.get("analyze", False)
    container = _c(request)
    pool = container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("run_script", {"script": script})
        output = result.data if hasattr(result, "data") else str(result)
        history_id = str(uuid.uuid4())
        await ds.execute(
            "INSERT INTO script_history (id, device_id, session_id, script, output, success, timestamp) "
            "VALUES ($1,$2,$3,$4,$5,$6,NOW())",
            (history_id, device_id, session_id, script, output, True),
        )
        return {"success": True, "data": {"result": {"success": True, "output": output}, "sessionId": session_id}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/scripts/execute/stream")
async def execute_script_stream(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    script = body.get("script", "")
    session_id = body.get("sessionId")
    container = _c(request)
    pool = container.device_pool()

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'status', 'message': 'Executing script...'})}\n\n"
            driver = await pool.get_driver(device_id)
            result = await driver.execute("run_script", {"script": script})
            output = result.data if hasattr(result, "data") else str(result)
            yield f"data: {json.dumps({'type': 'result', 'result': {'success': True, 'output': output}})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'sessionId': session_id})}\n\n"
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ==================== Execution History ====================

@router.get("/history")
async def get_history(
    device_id: str,
    session_id: str | None = Query(None, alias="sessionId"),
    type: str | None = Query(None),
    limit: int = Query(100),
    offset: int = Query(0),
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    base = "SELECT * FROM script_history WHERE device_id=$1"
    params: list = [device_id]
    idx = 2
    if session_id:
        base += f" AND session_id=${idx}"
        params.append(session_id)
        idx += 1
    base += f" ORDER BY timestamp DESC LIMIT ${idx} OFFSET ${idx+1}"
    params.extend([limit, offset])
    rows = await ds.query(base, params)
    return {"success": True, "data": rows}


@router.get("/history/stats")
async def get_history_stats(
    device_id: str,
    session_id: str | None = Query(None, alias="sessionId"),
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    where = "WHERE device_id=$1"
    params: list = [device_id]
    if session_id:
        where += " AND session_id=$2"
        params.append(session_id)
    row = await ds.query_one(
        f"SELECT COUNT(*) as total, SUM(CASE WHEN success THEN 1 ELSE 0 END) as succeeded FROM script_history {where}",
        params,
    )
    total = row["total"] if row else 0
    succeeded = row["succeeded"] if row else 0
    return {
        "success": True,
        "data": {
            "totalExecutions": total,
            "scriptExecutions": total,
            "toolCalls": 0,
            "successRate": (succeeded / total * 100) if total > 0 else 0,
            "recentExecutions": total,
        },
    }


@router.delete("/history")
async def clear_history(
    device_id: str,
    session_id: str | None = Query(None, alias="sessionId"),
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    if session_id:
        await ds.execute(
            "DELETE FROM script_history WHERE device_id=$1 AND session_id=$2",
            [device_id, session_id],
        )
    else:
        await ds.execute("DELETE FROM script_history WHERE device_id=$1", [device_id])
    return {"success": True, "message": "History cleared"}


# ==================== Message Collection ====================

@router.post("/sessions/{session_id}/messages/{message_id}/collect")
async def collect_message(
    device_id: str,
    session_id: str,
    message_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=true WHERE id=$1 AND session_id=$2",
        [message_id, session_id],
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message collected"}


@router.delete("/sessions/{session_id}/messages/{message_id}/collect")
async def uncollect_message(
    device_id: str,
    session_id: str,
    message_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.execute(
        "UPDATE chat_messages SET collected=false WHERE id=$1 AND session_id=$2",
        [message_id, session_id],
    )
    if rows == 0:
        raise HTTPException(404, "Message not found")
    return {"success": True, "message": "Message uncollected"}


@router.get("/sessions/{session_id}/collected")
async def get_collected_messages(
    device_id: str,
    session_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.query(
        "SELECT * FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC",
        [session_id],
    )
    return {"success": True, "data": rows}


@router.get("/sessions/{session_id}/collected/export")
async def export_collected_messages(
    device_id: str,
    session_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.query(
        "SELECT role, content FROM chat_messages WHERE session_id=$1 AND collected=true ORDER BY created_at ASC",
        [session_id],
    )
    export_text = "\n\n".join(f"**{r['role'].capitalize()}**: {r['content']}" for r in rows)
    return {"success": True, "data": export_text}


# ==================== Knowledge Conversion ====================

@router.post("/conversations/convert")
async def convert_to_knowledge(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
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
    kb = _c(request).knowledge_base()
    doc_id = await kb.add_entry(content=content, metadata={"title": title, "source": "chat_conversion"}, tags=tags)
    return {"success": True, "data": {"id": doc_id, "title": title}}


@router.post("/conversations/batch-convert")
async def batch_convert_to_knowledge(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    items = body.get("items", body.get("requests", []))
    results = []
    kb = _c(request).knowledge_base()
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
async def suggest_tags(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    content = body.get("content", "")
    words = content.lower().split()
    common_tags = {
        "network", "firewall", "routing", "interface", "vpn", "dns", "dhcp",
        "security", "performance", "monitoring", "backup", "config",
    }
    suggested = [w for w in set(words) if w in common_tags][:5]
    return {"success": True, "data": suggested}
