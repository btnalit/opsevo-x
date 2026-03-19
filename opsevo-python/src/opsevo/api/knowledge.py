"""Knowledge API routes — /api/ai-ops/rag/knowledge/*

Requirements: 3.1
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from opsevo.api.deps import get_current_user
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/ai-ops/rag", tags=["knowledge"])


def _get_vector_store(request: Request):
    provider = getattr(request.app.state.container, "vector_store", None)
    if provider is None:
        raise HTTPException(503, "Vector store service not available")
    return provider()


@router.post("/prompts")
async def upload_knowledge_prompt(
    request: Request,
    body: dict[str, Any],
    user: dict = Depends(get_current_user),
):
    text = body.get("text", "")
    if not text or not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "Prompt text (text) is required and cannot be empty")

    vs = _get_vector_store(request)
    doc_id = f"custom_prompt_{uuid.uuid4()}"
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()

    category = body.get("category", "system_prompt")
    device_types = body.get("deviceTypes", ["*"])
    if not isinstance(device_types, list):
        device_types = ["*"]
    tags = body.get("tags", [])
    if not isinstance(tags, list):
        tags = []

    await vs.add(
        text.strip(),
        metadata={
            "id": doc_id,
            "category": category,
            "deviceTypes": device_types,
            "tags": tags,
            "version": 1,
            "feedbackScore": 0.5,
            "hitCount": 0,
            "source": "user-upload",
            "createdAt": now,
        },
    )
    logger.info("knowledge_prompt_uploaded", id=doc_id)
    return {
        "success": True,
        "data": {
            "id": doc_id,
            "text": text.strip(),
            "category": category,
            "deviceTypes": device_types,
            "tags": tags,
            "createdAt": now,
        },
    }


@router.get("/prompts")
async def list_knowledge_prompts(
    request: Request,
    user: dict = Depends(get_current_user),
):
    vs = _get_vector_store(request)
    # Search all prompt_knowledge entries
    results = await vs.search("", top_k=100)
    return {"success": True, "data": results, "total": len(results)}
