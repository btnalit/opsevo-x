"""Embedding generation endpoint."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

router = APIRouter(prefix="/api/v1", tags=["embeddings"])


# ------------------------------------------------------------------
# Pydantic schemas (design doc Section 4.2)
# ------------------------------------------------------------------


class EmbeddingRequest(BaseModel):
    """Request body for POST /api/v1/embeddings."""

    texts: list[str]
    model: str | None = None

    @field_validator("texts")
    @classmethod
    def texts_must_not_be_empty(cls, v: list[str]) -> list[str]:
        if len(v) == 0:
            raise ValueError("texts list must not be empty")
        return v


class EmbeddingResponse(BaseModel):
    """Response body for POST /api/v1/embeddings."""

    embeddings: list[list[float]]
    model: str
    dimensions: int


# ------------------------------------------------------------------
# Endpoint
# ------------------------------------------------------------------


@router.post("/embeddings", response_model=EmbeddingResponse)
async def create_embeddings(body: EmbeddingRequest, request: Request):
    """Generate embeddings for input texts.

    Accepts a list of texts and returns their vector embeddings
    using the configured embedding model (local or remote).
    """
    from services.embedding_service import EmbeddingService

    embedding_service: EmbeddingService = request.app.state.embedding_service

    try:
        vectors = await embedding_service.embed(body.texts)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    dimensions = len(vectors[0]) if vectors and vectors[0] else 0

    return EmbeddingResponse(
        embeddings=vectors,
        model=body.model or embedding_service.model_name,
        dimensions=dimensions,
    )
