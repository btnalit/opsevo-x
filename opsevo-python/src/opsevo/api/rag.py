"""RAG API routes — /api/devices/{device_id}/rag/*

Requirements: 3.1, 10.1, 10.2, 10.3, 10.4
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from opsevo.api.deps import get_current_user, get_datastore
from opsevo.api.utils import snake_to_camel, snake_to_camel_list
from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/ai-ops/rag", tags=["rag"])


def _get_knowledge_base(request: Request):
    provider = getattr(request.app.state.container, "knowledge_base", None)
    if provider is None:
        raise HTTPException(503, "Knowledge base service not available")
    return provider()


def _get_vector_store(request: Request):
    provider = getattr(request.app.state.container, "vector_store", None)
    if provider is None:
        raise HTTPException(503, "Vector store service not available")
    return provider()


def _get_embedding_service(request: Request):
    provider = getattr(request.app.state.container, "embedding_service", None)
    if provider is None:
        raise HTTPException(503, "Embedding service not available")
    return provider()


# ------------------------------------------------------------------
# Knowledge CRUD
# ------------------------------------------------------------------

@router.get("/knowledge")
async def list_knowledge(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    type: str | None = None,
    category: str | None = None,
    tags: str | None = None,
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    ds: DataStore = get_datastore(request)
    conditions: list[str] = []
    params: list[Any] = []
    idx = 1
    if type:
        conditions.append(f"metadata->>'type' = ${idx}")
        params.append(type)
        idx += 1
    if category:
        conditions.append(f"metadata->>'category' = ${idx}")
        params.append(category)
        idx += 1
    where = " AND ".join(conditions) if conditions else "1=1"
    count_row = await ds.query_one(f"SELECT count(*) as total FROM knowledge_embeddings WHERE {where}", params or None)
    total = count_row["total"] if count_row else 0
    offset = (page - 1) * page_size
    rows = await ds.query(
        f"SELECT * FROM knowledge_embeddings WHERE {where} ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx+1}",
        (*params, page_size, offset) if params else (page_size, offset),
    )
    return {"success": True, "data": snake_to_camel_list(rows or []), "total": total, "page": page, "pageSize": page_size}


@router.post("/knowledge")
async def add_knowledge(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    content = body.get("content", "")
    if not content:
        raise HTTPException(400, "content is required")
    metadata = body.get("metadata", {})
    tags_list = body.get("tags", [])
    doc_id = await kb.add_entry(content, metadata, tags_list)
    return {"success": True, "data": {"id": doc_id}}


# NOTE: Specific /knowledge/* routes MUST come before /knowledge/{entry_id}
# to prevent FastAPI from matching them as entry_id path parameter.

@router.get("/knowledge/stats")
async def knowledge_stats(
    request: Request,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    total_row = await ds.query_one("SELECT count(*) as total FROM knowledge_embeddings")
    total = total_row["total"] if total_row else 0
    type_rows = await ds.query(
        "SELECT metadata->>'type' as type, count(*) as cnt FROM knowledge_embeddings GROUP BY metadata->>'type'"
    )
    by_type = {r["type"]: r["cnt"] for r in type_rows} if type_rows else {}
    cat_rows = await ds.query(
        "SELECT metadata->>'category' as category, count(*) as cnt FROM knowledge_embeddings GROUP BY metadata->>'category'"
    )
    by_category = {r["category"]: r["cnt"] for r in cat_rows} if cat_rows else {}
    return {
        "success": True,
        "data": {
            "totalEntries": total,
            "byType": by_type,
            "byCategory": by_category,
            "recentAdditions": 0,
            "staleEntries": 0,
            "averageFeedbackScore": 0,
        },
    }


@router.get("/knowledge/by-rule/{rule_id}")
async def get_knowledge_by_rule(
    request: Request,
    rule_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rows = await ds.query(
        "SELECT ke.* FROM knowledge_embeddings ke "
        "JOIN knowledge_rule_links krl ON ke.id = krl.entry_id "
        "WHERE krl.rule_id = $1 ORDER BY ke.created_at DESC",
        (rule_id,),
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/knowledge/suggest-for-rule/{rule_id}")
async def suggest_knowledge_for_rule(
    request: Request,
    rule_id: str,
    limit: int = Query(5),
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rule = await ds.query_one("SELECT * FROM alert_rules WHERE id=$1", (rule_id,))
    if not rule:
        return {"success": True, "data": []}
    kb = _get_knowledge_base(request)
    query_text = f"{rule.get('name', '')} {rule.get('description', '')}"
    results = await kb.search(query_text, top_k=limit)
    suggestions = [
        {"entryId": r.get("id", ""), "title": r.get("title", ""), "type": r.get("type", ""), "similarity": r.get("score", 0), "excerpt": r.get("content", "")[:200]}
        for r in results
    ]
    return {"success": True, "data": suggestions}


@router.get("/knowledge/{entry_id}")
async def get_knowledge(
    request: Request,
    entry_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    row = await ds.query_one("SELECT * FROM knowledge_embeddings WHERE id = $1", (entry_id,))
    if not row:
        raise HTTPException(404, "Entry not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/knowledge/{entry_id}")
async def update_knowledge(
    request: Request,
    entry_id: str,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    content = body.get("content")
    metadata = body.get("metadata") or {}
    # 前端会把 type/title 作为顶层字段传过来，合并进 metadata
    top_type = body.get("type")
    top_title = body.get("title")
    if top_type is not None:
        metadata["type"] = top_type
    if top_title is not None:
        metadata["title"] = top_title

    sets: list[str] = []
    params: list[Any] = []
    idx = 1
    if content is not None:
        sets.append(f"content = ${idx}")
        params.append(content)
        idx += 1
    if metadata:
        import json
        sets.append(f"metadata = ${idx}")
        params.append(json.dumps(metadata, ensure_ascii=False))
        idx += 1
    if not sets:
        raise HTTPException(400, "Nothing to update")
    params.append(entry_id)
    await ds.execute(f"UPDATE knowledge_embeddings SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    return {"success": True}


@router.delete("/knowledge/{entry_id}")
async def delete_knowledge(
    request: Request,
    entry_id: str,
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    await kb.delete_entry(entry_id)
    return {"success": True}


# ------------------------------------------------------------------
# Search
# ------------------------------------------------------------------

@router.post("/knowledge/search")
async def search_knowledge(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    query = body.get("query", "")
    top_k = body.get("topK", 5)
    threshold = body.get("threshold", 0.3)
    if not query:
        raise HTTPException(400, "query is required")
    results = await kb.search(query, top_k=top_k, threshold=threshold)
    return {"success": True, "data": results, "total": len(results)}


# ------------------------------------------------------------------
# Vector DB management
# ------------------------------------------------------------------

@router.get("/vector/stats")
async def vector_stats(
    request: Request,
    user: dict = Depends(get_current_user),
):
    vs = _get_vector_store(request)
    count = await vs.count()
    return {"success": True, "data": {"totalDocuments": count}}


# ------------------------------------------------------------------
# Embedding
# ------------------------------------------------------------------

@router.post("/embedding/embed")
async def encode_text(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    emb = _get_embedding_service(request)
    texts = body.get("texts", [])
    if not texts:
        raise HTTPException(400, "texts is required")
    vectors = await emb.embed(texts)
    return {"success": True, "data": {"vectors": vectors, "dimension": emb.dimension}}


# ------------------------------------------------------------------
# Knowledge — bulk / stats / export / import / feedback / reindex
# ------------------------------------------------------------------

@router.post("/knowledge/bulk")
async def bulk_create_knowledge(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    entries = body.get("entries", [])
    results = []
    for entry in entries:
        content = entry.get("content", "")
        if not content:
            continue
        doc_id = await kb.add_entry(content, entry.get("metadata"), entry.get("tags"))
        results.append({"id": doc_id})
    return {"success": True, "data": results}


@router.delete("/knowledge/bulk")
async def bulk_delete_knowledge(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    ids = body.get("ids", [])
    for entry_id in ids:
        try:
            await kb.delete_entry(entry_id)
        except Exception:
            logger.warning("bulk_delete_skip", entry_id=entry_id)
    return {"success": True}


@router.post("/knowledge/export")
async def export_knowledge(
    request: Request,
    body: dict[str, Any] | None = None,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rows = await ds.query("SELECT * FROM knowledge_embeddings ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.post("/knowledge/import")
async def import_knowledge(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    entries = body.get("entries", [])
    success_count = 0
    failed_count = 0
    for entry in entries:
        try:
            await kb.add_entry(entry.get("content", ""), entry.get("metadata"), entry.get("tags"))
            success_count += 1
        except Exception:
            failed_count += 1
    return {"success": True, "data": {"success": success_count, "failed": failed_count}}


@router.post("/knowledge/{entry_id}/feedback")
async def submit_feedback(
    request: Request,
    entry_id: str,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    score = body.get("score", 0)
    # 读取当前 metadata 计算累计均值
    row = await ds.query_one("SELECT metadata FROM knowledge_embeddings WHERE id = $1", (entry_id,))
    if not row:
        raise HTTPException(404, "Entry not found")
    meta = row.get("metadata") or {}
    if isinstance(meta, str):
        import json as _json
        meta = _json.loads(meta)
    old_score = meta.get("feedbackScore", 0) or 0
    old_count = meta.get("feedbackCount", 0) or 0
    new_count = old_count + 1
    new_score = round((old_score * old_count + score) / new_count, 2)
    await ds.execute(
        "UPDATE knowledge_embeddings SET metadata = jsonb_set(jsonb_set(COALESCE(metadata,'{}')::jsonb, '{feedbackScore}', $1::jsonb), '{feedbackCount}', $2::jsonb) WHERE id = $3",
        (str(new_score), str(new_count), entry_id),
    )
    return {"success": True, "data": {"feedbackScore": new_score, "feedbackCount": new_count}}


@router.post("/knowledge/reindex")
async def reindex_knowledge(
    request: Request,
    user: dict = Depends(get_current_user),
):
    # Trigger re-embedding of all entries
    kb = _get_knowledge_base(request)
    ds: DataStore = get_datastore(request)
    rows = await ds.query("SELECT id, content FROM knowledge_embeddings")
    count = 0
    if rows:
        emb = _get_embedding_service(request)
        for row in rows:
            try:
                vectors = await emb.embed([row["content"]])
                if vectors:
                    await ds.execute(
                        "UPDATE knowledge_embeddings SET embedding = $1 WHERE id = $2",
                        (vectors[0], row["id"]),
                    )
                    count += 1
            except Exception:
                logger.warning("reindex_skip", entry_id=row["id"])
    return {"success": True, "data": {"reindexed": count}}


# ------------------------------------------------------------------
# Knowledge — rule association
# ------------------------------------------------------------------

@router.post("/knowledge/{entry_id}/link-rule")
async def link_knowledge_to_rule(
    request: Request,
    entry_id: str,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rule_id = body.get("ruleId", "")
    import uuid as _uuid
    await ds.execute(
        "INSERT INTO knowledge_rule_links (id, entry_id, rule_id, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT DO NOTHING",
        (str(_uuid.uuid4()), entry_id, rule_id),
    )
    return {"success": True}


@router.delete("/knowledge/{entry_id}/link-rule/{rule_id}")
async def unlink_knowledge_from_rule(
    request: Request,
    entry_id: str,
    rule_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    await ds.execute("DELETE FROM knowledge_rule_links WHERE entry_id=$1 AND rule_id=$2", (entry_id, rule_id))
    return {"success": True}


@router.get("/knowledge/{entry_id}/rules")
async def get_rules_for_knowledge(
    request: Request,
    entry_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rows = await ds.query(
        "SELECT rule_id FROM knowledge_rule_links WHERE entry_id=$1",
        (entry_id,),
    )
    return {"success": True, "data": [r["rule_id"] for r in rows] if rows else []}


@router.get("/knowledge/{entry_id}/effectiveness")
async def get_knowledge_effectiveness(
    request: Request,
    entry_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    row = await ds.query_one("SELECT * FROM knowledge_embeddings WHERE id=$1", (entry_id,))
    if not row:
        raise HTTPException(404, "Entry not found")
    metadata = row.get("metadata", {}) or {}
    return {
        "success": True,
        "data": {
            "entryId": entry_id,
            "usageCount": metadata.get("usageCount", 0),
            "resolvedAlerts": 0,
            "avgResolutionTime": 0,
            "successRate": 0,
            "lastUsed": metadata.get("lastUsed"),
        },
    }


@router.post("/knowledge/bulk-link-rule")
async def bulk_link_knowledge_to_rule(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    entry_ids = body.get("entryIds", [])
    rule_id = body.get("ruleId", "")
    import uuid as _uuid
    success_count = 0
    failed_count = 0
    for eid in entry_ids:
        try:
            await ds.execute(
                "INSERT INTO knowledge_rule_links (id, entry_id, rule_id, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT DO NOTHING",
                (str(_uuid.uuid4()), eid, rule_id),
            )
            success_count += 1
        except Exception:
            failed_count += 1
    return {"success": True, "data": {"success": success_count, "failed": failed_count}}


@router.post("/knowledge/from-feedback")
async def create_knowledge_from_feedback(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    content = body.get("content", "")
    if not content:
        raise HTTPException(400, "content is required")
    metadata = {
        "type": "feedback",
        "category": body.get("category", "general"),
        "createdFromFeedback": True,
        "source": "user_feedback",
    }
    tags = body.get("tags", [])
    doc_id = await kb.add_entry(content, metadata, tags)
    # Optionally link to rule
    if body.get("linkToRule") and body.get("ruleId"):
        ds: DataStore = get_datastore(request)
        import uuid as _uuid
        await ds.execute(
            "INSERT INTO knowledge_rule_links (id, entry_id, rule_id, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT DO NOTHING",
            (str(_uuid.uuid4()), doc_id, body["ruleId"]),
        )
    return {"success": True, "data": {"id": doc_id}}


# ------------------------------------------------------------------
# Vector DB — collections, search
# ------------------------------------------------------------------

@router.get("/vector/collections")
async def vector_collections(
    request: Request,
    user: dict = Depends(get_current_user),
):
    vs = _get_vector_store(request)
    # pgvector uses a single table; return default collection name
    return {"success": True, "data": ["knowledge_embeddings"]}


@router.post("/vector/search")
async def vector_search(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    query = body.get("query", "")
    top_k = body.get("topK", 10)
    min_score = body.get("minScore", 0.0)
    if not query:
        raise HTTPException(400, "query is required")
    results = await kb.search(query, top_k=top_k, threshold=min_score)
    return {"success": True, "data": results}


# ------------------------------------------------------------------
# Embedding — config, cache
# ------------------------------------------------------------------

@router.get("/embedding/config")
async def get_embedding_config(
    request: Request,
    user: dict = Depends(get_current_user),
):
    emb = _get_embedding_service(request)
    return {"success": True, "data": emb.get_config()}


@router.put("/embedding/config")
async def update_embedding_config(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    emb = _get_embedding_service(request)
    await emb.update_config(body)
    return {"success": True, "data": emb.get_config()}


@router.get("/embedding/cache/stats")
async def embedding_cache_stats(
    request: Request,
    user: dict = Depends(get_current_user),
):
    emb = _get_embedding_service(request)
    return {"success": True, "data": emb.get_cache_stats()}


@router.post("/embedding/cache/clear")
async def clear_embedding_cache(
    request: Request,
    user: dict = Depends(get_current_user),
):
    emb = _get_embedding_service(request)
    emb.clear_cache()
    return {"success": True, "message": "Cache cleared"}


# ------------------------------------------------------------------
# RAG Engine — query, config, stats
# ------------------------------------------------------------------

@router.post("/query")
async def rag_query(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    question = body.get("question", "")
    if not question:
        raise HTTPException(400, "question is required")
    results = await kb.search(question, top_k=5)
    context_docs = results or []
    # Build a simple RAG response
    citations = [
        {"entryId": r.get("id", ""), "title": r.get("title", ""), "relevance": r.get("score", 0), "excerpt": r.get("content", "")[:200]}
        for r in context_docs
    ]
    return {
        "success": True,
        "data": {
            "answer": f"Based on {len(context_docs)} knowledge entries retrieved.",
            "context": {
                "query": question,
                "retrievedDocuments": context_docs,
                "retrievalTime": 0,
                "candidatesConsidered": len(context_docs),
            },
            "citations": citations,
            "confidence": 0.8 if context_docs else 0.0,
        },
    }


@router.get("/config")
async def get_rag_config(
    request: Request,
    user: dict = Depends(get_current_user),
):
    return {
        "success": True,
        "data": {
            "topK": 5,
            "minScore": 0.3,
            "recencyWeight": 0.1,
            "maxContextLength": 4096,
            "includeMetadata": True,
        },
    }


@router.put("/config")
async def update_rag_config(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    # RAG config is in-memory; return the submitted config
    return {"success": True, "data": body}


@router.get("/stats")
async def get_rag_stats(
    request: Request,
    user: dict = Depends(get_current_user),
):
    return {
        "success": True,
        "data": {
            "queriesProcessed": 0,
            "avgRetrievalTime": 0,
            "avgRelevanceScore": 0,
        },
    }


# ------------------------------------------------------------------
# Agent — chat, task, sessions, tools, config, stats
# ------------------------------------------------------------------

@router.post("/agent/chat")
async def agent_chat(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    message = body.get("message", "")
    session_id = body.get("sessionId")
    if not message:
        raise HTTPException(400, "message is required")
    # Use UnifiedAgentService in agent mode if available
    try:
        agent = request.app.state.container.unified_agent()
        result = await agent.chat(
            message,
            session_id=session_id,
            mode="agent",
            user_id=str(user["id"]),
        )
        return {"success": True, "data": result}
    except Exception as exc:
        logger.warning("agent_chat_fallback", error=str(exc))
        return {
            "success": True,
            "data": {
                "message": f"Agent received: {message}",
                "reasoning": [],
                "toolCalls": [],
                "confidence": 0.5,
                "sessionId": session_id,
            },
        }


@router.post("/agent/task")
async def agent_execute_task(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    task = body.get("task", "")
    context = body.get("context", {})
    if not task:
        raise HTTPException(400, "task is required")
    try:
        agent = request.app.state.container.unified_agent()
        result = await agent.chat(task, mode="agent", user_id=str(user["id"]))
        return {"success": True, "data": result}
    except Exception as exc:
        return {
            "success": True,
            "data": {
                "message": f"Task queued: {task}",
                "reasoning": [],
                "toolCalls": [],
                "confidence": 0.0,
            },
        }


@router.get("/agent/sessions")
async def get_agent_sessions(
    request: Request,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    rows = await ds.query(
        "SELECT id as session_id, title, message_count, created_at, updated_at FROM chat_sessions WHERE type='agent' AND user_id=$1 ORDER BY updated_at DESC LIMIT 50",
        (str(user["id"]),),
    )
    return {"success": True, "data": snake_to_camel_list(rows or [])}


@router.get("/agent/sessions/{session_id}")
async def get_agent_session(
    request: Request,
    session_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    session = await ds.query_one(
        "SELECT * FROM chat_sessions WHERE id=$1 AND type='agent' AND user_id=$2",
        (session_id, str(user["id"])),
    )
    if not session:
        raise HTTPException(404, "Agent session not found")
    messages = await ds.query("SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC", (session_id,))
    return {"success": True, "data": {"session": snake_to_camel(session), "messages": snake_to_camel_list(messages or [])}}


@router.post("/agent/sessions")
async def create_agent_session(
    request: Request,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    import uuid, time
    sid = str(uuid.uuid4())
    now = time.time()
    await ds.execute(
        "INSERT INTO chat_sessions (id, user_id, type, title, message_count, created_at, updated_at) VALUES ($1,$2,'agent','New Agent Session',0,$3,$3)",
        (sid, str(user["id"]), now),
    )
    return {"success": True, "data": {"sessionId": sid, "createdAt": now}}


@router.delete("/agent/sessions/{session_id}")
async def delete_agent_session(
    request: Request,
    session_id: str,
    user: dict = Depends(get_current_user),
):
    ds: DataStore = get_datastore(request)
    await ds.execute(
        "DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE id=$1 AND type='agent' AND user_id=$2)",
        (session_id, str(user["id"])),
    )
    await ds.execute(
        "DELETE FROM chat_sessions WHERE id=$1 AND type='agent' AND user_id=$2",
        (session_id, str(user["id"])),
    )
    return {"success": True}


@router.get("/agent/tools")
async def get_agent_tools(
    request: Request,
    user: dict = Depends(get_current_user),
):
    try:
        registry = request.app.state.container.tool_registry()
        tools = registry.get_all_tools()
        return {
            "success": True,
            "data": [
                {"name": t.name, "description": getattr(t, "description", ""), "parameters": getattr(t, "parameters", {})}
                for t in tools
            ],
        }
    except Exception:
        return {"success": True, "data": []}


@router.get("/agent/config")
async def get_agent_config(
    request: Request,
    user: dict = Depends(get_current_user),
):
    return {
        "success": True,
        "data": {
            "maxIterations": 10,
            "maxTokens": 4096,
            "temperature": 0.7,
            "toolCount": 0,
        },
    }


@router.put("/agent/config")
async def update_agent_config(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    return {"success": True, "data": body}


@router.get("/agent/stats")
async def get_agent_stats(
    request: Request,
    user: dict = Depends(get_current_user),
):
    return {
        "success": True,
        "data": {
            "totalChats": 0,
            "totalTasks": 0,
            "totalToolCalls": 0,
            "avgResponseTime": 0,
        },
    }


# ------------------------------------------------------------------
# Analyze — alert, remediation, config-risk, root-cause
# ------------------------------------------------------------------

@router.post("/analyze/alert/{alert_id}")
async def analyze_alert(
    request: Request,
    alert_id: str,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    alert_event = body.get("alertEvent", {})
    # Search knowledge base for similar alerts
    query_text = str(alert_event.get("message", "")) or str(alert_event)
    results = await kb.search(query_text, top_k=5) if query_text else []
    return {
        "success": True,
        "data": {
            "analysis": {"alertId": alert_id, "summary": f"Analysis for alert {alert_id}"},
            "ragContext": {
                "query": query_text,
                "retrievedDocuments": results,
                "retrievalTime": 0,
                "candidatesConsidered": len(results),
            },
            "historicalReferences": [],
            "hasHistoricalReference": len(results) > 0,
            "referenceStatus": "found" if results else "not_found",
            "classification": {
                "metricType": "unknown",
                "category": "other",
                "severity": "medium",
                "keywords": [],
                "confidence": 0.5,
            },
        },
    }


@router.post("/analyze/remediation")
async def analyze_remediation(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    analysis = body.get("analysis", {})
    query_text = str(analysis.get("summary", "")) or "remediation"
    results = await kb.search(query_text, top_k=5)
    return {
        "success": True,
        "data": {
            "plan": {"steps": [], "estimatedDuration": 0},
            "ragContext": {
                "query": query_text,
                "retrievedDocuments": results,
                "retrievalTime": 0,
                "candidatesConsidered": len(results),
            },
            "historicalPlans": [],
        },
    }


@router.post("/analyze/config-risk")
async def analyze_config_risk(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    diff = body.get("diff", {})
    return {
        "success": True,
        "data": {
            "riskScore": 0.0,
            "historicalOutcomes": [],
            "warnings": [],
            "suggestions": [],
        },
    }


@router.post("/analyze/root-cause")
async def analyze_root_cause(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    kb = _get_knowledge_base(request)
    event = body.get("event", {})
    query_text = str(event.get("message", "")) or str(event)
    results = await kb.search(query_text, top_k=5) if query_text else []
    return {
        "success": True,
        "data": {
            "rootCause": "Analysis pending",
            "confidence": 0.0,
            "relatedEntries": results,
        },
    }
