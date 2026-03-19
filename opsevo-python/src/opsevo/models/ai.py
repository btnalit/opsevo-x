"""AI service Pydantic models.

Requirements: 2.3, 3.2, 11.1
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ── Chat ──────────────────────────────────────────────────────────────────

class RAGOptions(BaseModel):
    top_k: int = Field(default=5, alias="topK")
    threshold: float = 0.5
    rerank: bool = False
    include_citations: bool = Field(default=True, alias="includeCitations")

    model_config = {"populate_by_name": True}


class ChatRequest(BaseModel):
    message: str
    mode: str = "general"  # general | rag | agent
    session_id: str | None = Field(default=None, alias="sessionId")
    stream: bool = False
    rag_options: RAGOptions | None = Field(default=None, alias="ragOptions")

    model_config = {"populate_by_name": True}


class RAGCitation(BaseModel):
    source: str = ""
    content: str = ""
    relevance: float = 0.0
    metadata: dict = Field(default_factory=dict)


class AgentToolCall(BaseModel):
    tool: str = ""
    arguments: dict = Field(default_factory=dict)
    result: Any = None


class ChatResponse(BaseModel):
    message: str
    session_id: str = Field(default="", alias="sessionId")
    mode: str = "general"
    citations: list[RAGCitation] = Field(default_factory=list)
    tool_calls: list[AgentToolCall] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class StreamChunk(BaseModel):
    type: str  # content | tool_call | citation | done | error
    content: str = ""
    metadata: dict = Field(default_factory=dict)


# ── Sessions ──────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    title: str = ""
    mode: str = "general"
    device_id: str = Field(default="", alias="deviceId")

    model_config = {"populate_by_name": True}


class SessionUpdate(BaseModel):
    title: str | None = None
    mode: str | None = None


class SessionResponse(BaseModel):
    id: str
    title: str = ""
    mode: str = "general"
    device_id: str = Field(default="", alias="deviceId")
    message_count: int = Field(default=0, alias="messageCount")
    created_at: str = Field(default="", alias="createdAt")
    updated_at: str = Field(default="", alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── AI Config ─────────────────────────────────────────────────────────────

class AIConfigCreate(BaseModel):
    name: str
    provider: str
    model_name: str = Field(alias="modelName", default="")
    api_key: str = Field(alias="apiKey", default="")
    base_url: str = Field(alias="baseUrl", default="")
    is_default: bool = Field(alias="isDefault", default=False)

    model_config = {"populate_by_name": True}


class AIConfigUpdate(BaseModel):
    name: str | None = None
    provider: str | None = None
    model_name: str | None = Field(alias="modelName", default=None)
    api_key: str | None = Field(alias="apiKey", default=None)
    base_url: str | None = Field(alias="baseUrl", default=None)
    is_default: bool | None = Field(alias="isDefault", default=None)

    model_config = {"populate_by_name": True}


class AIConfigResponse(BaseModel):
    id: str
    name: str
    provider: str
    model_name: str = Field(default="", alias="modelName")
    base_url: str = Field(default="", alias="baseUrl")
    is_default: bool = Field(default=False, alias="isDefault")
    created_at: str = Field(default="", alias="createdAt")
    updated_at: str = Field(default="", alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── Script Execution ──────────────────────────────────────────────────────

class ScriptExecuteRequest(BaseModel):
    script: str
    language: str = ""
    session_id: str = Field(default="", alias="sessionId")

    model_config = {"populate_by_name": True}


class ScriptValidateRequest(BaseModel):
    script: str
    language: str = ""


class ScriptExecuteResponse(BaseModel):
    success: bool
    output: str = ""
    error: str | None = None
    execution_time_ms: float = Field(default=0.0, alias="executionTimeMs")

    model_config = {"populate_by_name": True}
