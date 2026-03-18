"""Vector store service using psycopg 3 (async) + pgvector.

Supports three collections mapped to PostgreSQL tables:
- prompt_knowledge: Prompt knowledge base vectors
- tool_vectors: Tool description vectors
- vector_documents: General vector documents

Each collection has different column layouts; the VectorStore handles
the mapping transparently.
"""

import json
import logging
import re
import uuid
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Collection configuration — maps collection name to table/column details
# ---------------------------------------------------------------------------

VECTOR_DIMENSION = 384


@dataclass(frozen=True)
class CollectionConfig:
    """Describes how a collection maps to a PostgreSQL table."""

    table: str
    content_column: str
    has_embedding: bool  # whether the table has an embedding vector column


COLLECTIONS: dict[str, CollectionConfig] = {
    "prompt_knowledge": CollectionConfig(
        table="prompt_knowledge",
        content_column="text",
        has_embedding=True,
    ),
    "tool_vectors": CollectionConfig(
        table="tool_vectors",
        content_column="description",
        has_embedding=True,
    ),
    "vector_documents": CollectionConfig(
        table="vector_documents",
        content_column="content",
        has_embedding=False,  # table lacks embedding column; added at init
    ),
}


@dataclass
class SearchResult:
    """A single vector search result."""

    id: str
    content: str
    score: float
    metadata: dict


# ---------------------------------------------------------------------------
# VectorStore
# ---------------------------------------------------------------------------


class VectorStore:
    """Async vector store backed by PostgreSQL + pgvector.

    Lifecycle:
        store = VectorStore()
        await store.initialize()   # creates connection pool, ensures schema
        ...
        await store.close()        # shuts down pool
    """

    def __init__(self) -> None:
        self._pool: AsyncConnectionPool | None = None


    async def initialize(self) -> None:
        """Create the connection pool and ensure schema is ready."""
        logger.info("Initializing VectorStore connection pool")
        self._pool = AsyncConnectionPool(
            conninfo=settings.DATABASE_URL,
            min_size=2,
            max_size=10,
            open=False,
        )
        await self._pool.open()
        await self._ensure_vector_documents_embedding()
        logger.info("VectorStore initialized successfully")

    async def close(self) -> None:
        """Shut down the connection pool."""
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
            logger.info("VectorStore connection pool closed")

    # ------------------------------------------------------------------
    # Schema helpers
    # ------------------------------------------------------------------

    async def _ensure_vector_documents_embedding(self) -> None:
        """Add an ``embedding`` column to ``vector_documents`` if missing.

        The 001_core_tables migration created vector_documents without an
        embedding column.  We add it here so the collection is fully usable
        for vector search.
        """
        async with self._pool.connection() as conn:
            row = await conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'vector_documents' AND column_name = 'embedding'"
            )
            exists = await row.fetchone()
            if not exists:
                logger.info("Adding embedding column to vector_documents table")
                await conn.execute(
                    f"ALTER TABLE vector_documents ADD COLUMN embedding vector({VECTOR_DIMENSION})"
                )
                await conn.commit()
                # Update the collection config to reflect the new column
                COLLECTIONS["vector_documents"] = CollectionConfig(
                    table="vector_documents",
                    content_column="content",
                    has_embedding=True,
                )
                logger.info("embedding column added to vector_documents")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def upsert(
        self,
        collection: str,
        doc_id: str | None,
        content: str,
        embedding: list[float],
        metadata: dict,
    ) -> str:
        """Insert or update a vector document. Returns the document ID."""
        cfg = self._get_collection(collection)
        if doc_id is None:
            doc_id = str(uuid.uuid4())

        embedding_str = _format_vector(embedding)

        async with self._pool.connection() as conn:
            if collection == "prompt_knowledge":
                # prompt_knowledge has a NOT NULL `category` column.
                # Callers pass it via metadata["category"]; default "general".
                category = metadata.pop("category", "general")
                await conn.execute(
                    f"""
                    INSERT INTO {cfg.table}
                        (id, {cfg.content_column}, embedding, category, metadata)
                    VALUES
                        (%(id)s, %(content)s, %(embedding)s, %(category)s,
                         %(metadata)s::jsonb)
                    ON CONFLICT (id) DO UPDATE SET
                        {cfg.content_column} = EXCLUDED.{cfg.content_column},
                        embedding = EXCLUDED.embedding,
                        category = EXCLUDED.category,
                        metadata = EXCLUDED.metadata,
                        updated_at = NOW()
                    """,
                    {
                        "id": doc_id,
                        "content": content,
                        "embedding": embedding_str,
                        "category": category,
                        "metadata": _json_dumps(metadata),
                    },
                )
            elif collection == "tool_vectors":
                # tool_vectors has NOT NULL: tool_id (UNIQUE), tool_name,
                # tool_type.  Callers pass these via metadata.
                tool_id = metadata.pop("tool_id", doc_id)
                tool_name = metadata.pop("tool_name", "")
                tool_type = metadata.pop("tool_type", "unknown")
                await conn.execute(
                    f"""
                    INSERT INTO {cfg.table}
                        (id, {cfg.content_column}, embedding, metadata,
                         tool_id, tool_name, tool_type)
                    VALUES
                        (%(id)s, %(content)s, %(embedding)s, %(metadata)s::jsonb,
                         %(tool_id)s, %(tool_name)s, %(tool_type)s)
                    ON CONFLICT (id) DO UPDATE SET
                        {cfg.content_column} = EXCLUDED.{cfg.content_column},
                        embedding = EXCLUDED.embedding,
                        metadata = EXCLUDED.metadata,
                        tool_id = EXCLUDED.tool_id,
                        tool_name = EXCLUDED.tool_name,
                        tool_type = EXCLUDED.tool_type,
                        updated_at = NOW()
                    """,
                    {
                        "id": doc_id,
                        "content": content,
                        "embedding": embedding_str,
                        "metadata": _json_dumps(metadata),
                        "tool_id": tool_id,
                        "tool_name": tool_name,
                        "tool_type": tool_type,
                    },
                )
            else:
                # vector_documents — generic collection
                await conn.execute(
                    f"""
                    INSERT INTO {cfg.table}
                        (id, {cfg.content_column}, embedding, metadata)
                    VALUES
                        (%(id)s, %(content)s, %(embedding)s, %(metadata)s::jsonb)
                    ON CONFLICT (id) DO UPDATE SET
                        {cfg.content_column} = EXCLUDED.{cfg.content_column},
                        embedding = EXCLUDED.embedding,
                        metadata = EXCLUDED.metadata,
                        updated_at = NOW()
                    """,
                    {
                        "id": doc_id,
                        "content": content,
                        "embedding": embedding_str,
                        "metadata": _json_dumps(metadata),
                    },
                )
            await conn.commit()

        logger.debug("Upserted doc %s into %s", doc_id, collection)
        return doc_id

    async def search(
        self,
        collection: str,
        query_embedding: list[float],
        top_k: int = 5,
        filter: dict | None = None,
    ) -> list[SearchResult]:
        """Cosine similarity search within a collection."""
        cfg = self._get_collection(collection)
        if not cfg.has_embedding:
            logger.warning(
                "Collection %s has no embedding column; returning empty results",
                collection,
            )
            return []

        embedding_str = _format_vector(query_embedding)

        # Build optional WHERE clauses from filter dict
        where_clauses: list[str] = []
        params: dict = {
            "embedding": embedding_str,
            "top_k": top_k,
        }

        if filter:
            for i, (key, value) in enumerate(filter.items()):
                param_name = f"filter_{i}"
                # Support filtering on JSONB metadata keys
                where_clauses.append(
                    f"metadata->>%(filter_key_{i})s = %(filter_val_{i})s"
                )
                params[f"filter_key_{i}"] = key
                params[f"filter_val_{i}"] = str(value)

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        query = f"""
            SELECT id, {cfg.content_column} AS content,
                   1 - (embedding <=> %(embedding)s) AS score,
                   metadata
            FROM {cfg.table}
            {where_sql}
            ORDER BY embedding <=> %(embedding)s
            LIMIT %(top_k)s
        """

        results: list[SearchResult] = []
        async with self._pool.connection() as conn:
            cursor = await conn.execute(query, params)
            rows = await cursor.fetchall()
            for row in rows:
                results.append(
                    SearchResult(
                        id=str(row[0]),
                        content=row[1],
                        score=float(row[2]) if row[2] is not None else 0.0,
                        metadata=_parse_metadata(row[3]),
                    )
                )

        return results

    async def delete(self, collection: str, doc_id: str) -> bool:
        """Delete a document by ID. Returns True if a row was deleted."""
        cfg = self._get_collection(collection)

        async with self._pool.connection() as conn:
            cursor = await conn.execute(
                f"DELETE FROM {cfg.table} WHERE id = %(id)s",
                {"id": doc_id},
            )
            await conn.commit()
            return cursor.rowcount > 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_collection(self, name: str) -> CollectionConfig:
        """Resolve a collection name to its config, or raise ValueError."""
        cfg = COLLECTIONS.get(name)
        if cfg is None:
            raise ValueError(
                f"Unknown collection '{name}'. "
                f"Valid collections: {', '.join(COLLECTIONS)}"
            )
        # Defensive check: ensure table name contains only safe characters
        if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', cfg.table):
            raise ValueError(
                f"Invalid table name '{cfg.table}' for collection '{name}'. "
                "Table names must contain only letters, digits, and underscores."
            )
        return cfg


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _format_vector(vec: list[float]) -> str:
    """Format a float list as a pgvector literal, e.g. '[0.1,0.2,0.3]'."""
    return "[" + ",".join(str(v) for v in vec) + "]"


def _json_dumps(obj: dict) -> str:
    """Serialize a dict to a JSON string for JSONB columns."""
    return json.dumps(obj, ensure_ascii=False)


def _parse_metadata(raw) -> dict:
    """Parse metadata from a DB row (may be dict, str, or None)."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}
