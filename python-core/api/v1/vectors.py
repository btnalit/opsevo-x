"""Vector store operation endpoints.

Provides:
- POST /api/v1/vectors/upsert  — upsert a document (auto-embed if needed)
- POST /api/v1/vectors/search  — search by text or embedding vector
- DELETE /api/v1/vectors/{collection}/{doc_id} — delete a document
"""

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, field_validator

router = APIRouter(prefix="/api/v1", tags=["vectors"])

VALID_COLLECTIONS = {"prompt_knowledge", "tool_vectors", "vector_documents"}


# ------------------------------------------------------------------
# Pydantic schemas
# ------------------------------------------------------------------


class UpsertRequest(BaseModel):
    """Request body for POST /api/v1/vectors/upsert."""

    collection: str
    id: str | None = None
    content: str
    embedding: list[float] | None = None
    metadata: dict = {}

    @field_validator("collection")
    @classmethod
    def validate_collection(cls, v: str) -> str:
        if v not in VALID_COLLECTIONS:
            raise ValueError(
                f"Invalid collection '{v}'. "
                f"Must be one of: {', '.join(sorted(VALID_COLLECTIONS))}"
            )
        return v

    @field_validator("content")
    @classmethod
    def content_must_not_be_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("content must not be empty")
        return v


class UpsertResponse(BaseModel):
    """Response body for POST /api/v1/vectors/upsert."""

    id: str
    collection: str


class SearchRequest(BaseModel):
    """Request body for POST /api/v1/vectors/search."""

    collection: str
    query: str | None = None
    query_embedding: list[float] | None = None
    top_k: int = 5
    filter: dict | None = None
    min_score: float = 0.0

    @field_validator("collection")
    @classmethod
    def validate_collection(cls, v: str) -> str:
        if v not in VALID_COLLECTIONS:
            raise ValueError(
                f"Invalid collection '{v}'. "
                f"Must be one of: {', '.join(sorted(VALID_COLLECTIONS))}"
            )
        return v


class SearchResultItem(BaseModel):
    """A single search result."""

    id: str
    content: str
    score: float
    metadata: dict


class SearchResponse(BaseModel):
    """Response body for POST /api/v1/vectors/search."""

    results: list[SearchResultItem]


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _get_vector_store(request: Request):
    """Return the VectorStore from app state, or raise 503 if unavailable."""
    store = getattr(request.app.state, "vector_store", None)
    if store is None:
        raise HTTPException(
            status_code=503,
            detail="Vector store is unavailable (database connection failed)",
        )
    return store


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------


@router.post("/vectors/upsert", response_model=UpsertResponse)
async def upsert_vectors(body: UpsertRequest, request: Request):
    """Upsert a vector document into a collection.

    If ``embedding`` is not provided, the text is auto-embedded using
    the EmbeddingService.
    """
    from services.embedding_service import EmbeddingService

    vector_store = _get_vector_store(request)
    embedding_service: EmbeddingService = request.app.state.embedding_service

    embedding = body.embedding
    if embedding is None:
        try:
            vectors = await embedding_service.embed([body.content])
            embedding = vectors[0]
        except RuntimeError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Embedding service unavailable: {exc}",
            ) from exc

    try:
        doc_id = await vector_store.upsert(
            collection=body.collection,
            doc_id=body.id,
            content=body.content,
            embedding=embedding,
            metadata=body.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Vector store error: {exc}",
        ) from exc

    return UpsertResponse(id=doc_id, collection=body.collection)


@router.post("/vectors/search", response_model=SearchResponse)
async def search_vectors(body: SearchRequest, request: Request):
    """Search for similar vectors in a collection.

    Provide either ``query`` (text — auto-embedded) or ``query_embedding``
    (raw vector).  If both are given, ``query_embedding`` takes precedence.
    """
    from services.embedding_service import EmbeddingService

    vector_store = _get_vector_store(request)
    embedding_service: EmbeddingService = request.app.state.embedding_service

    query_embedding = body.query_embedding

    if query_embedding is None:
        if body.query is None or not body.query.strip():
            raise HTTPException(
                status_code=400,
                detail="Either 'query' (text) or 'query_embedding' (vector) must be provided",
            )
        try:
            vectors = await embedding_service.embed([body.query])
            query_embedding = vectors[0]
        except RuntimeError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Embedding service unavailable: {exc}",
            ) from exc

    try:
        results = await vector_store.search(
            collection=body.collection,
            query_embedding=query_embedding,
            top_k=body.top_k,
            filter=body.filter,
            min_score=body.min_score,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Vector store error: {exc}",
        ) from exc

    return SearchResponse(
        results=[
            SearchResultItem(
                id=r.id,
                content=r.content,
                score=r.score,
                metadata=r.metadata,
            )
            for r in results
        ]
    )


@router.delete("/vectors/{collection}/{doc_id}", status_code=204)
async def delete_vector(collection: str, doc_id: str, request: Request):
    """Delete a vector document from a collection."""
    if collection not in VALID_COLLECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid collection '{collection}'. "
            f"Must be one of: {', '.join(sorted(VALID_COLLECTIONS))}",
        )

    vector_store = _get_vector_store(request)

    try:
        deleted = await vector_store.delete(collection=collection, doc_id=doc_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Vector store error: {exc}",
        ) from exc

    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found")

    return Response(status_code=204)
