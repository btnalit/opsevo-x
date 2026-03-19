"""DocumentProcessor — document chunking, vectorization and indexing.

Requirements: 10.4
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from opsevo.services.rag.embedding import EmbeddingService
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ChunkOptions:
    chunk_size: int = 500
    chunk_overlap: int = 50
    separator: str = "\n"


@dataclass
class DocumentSource:
    type: str  # alert, remediation, config, pattern, manual, feedback, learning, experience
    id: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProcessedDocument:
    id: str
    original_id: str
    chunk_index: int
    content: str
    vector: list[float]
    metadata: dict[str, Any] = field(default_factory=dict)


class DocumentProcessor:
    def __init__(self, embedding_service: EmbeddingService, options: ChunkOptions | None = None):
        self._embedding = embedding_service
        self._options = options or ChunkOptions()

    async def process(self, source: DocumentSource) -> list[ProcessedDocument]:
        chunks = self.chunk(source.content)
        if not chunks:
            logger.warning("document_no_chunks", source_id=source.id)
            return []
        vectors = await self._embedding.embed(chunks)
        docs: list[ProcessedDocument] = []
        for i, (text, vec) in enumerate(zip(chunks, vectors)):
            docs.append(ProcessedDocument(
                id=f"{source.id}_chunk_{i}",
                original_id=source.id,
                chunk_index=i,
                content=text,
                vector=vec,
                metadata={
                    **source.metadata,
                    "source": source.type,
                    "originalId": source.id,
                    "chunkIndex": i,
                    "totalChunks": len(chunks),
                    "timestamp": int(time.time() * 1000),
                },
            ))
        logger.debug("document_processed", source_id=source.id, chunks=len(docs))
        return docs

    async def process_batch(self, sources: list[DocumentSource]) -> list[ProcessedDocument]:
        all_docs: list[ProcessedDocument] = []
        for src in sources:
            try:
                all_docs.extend(await self.process(src))
            except Exception:
                logger.error("document_batch_item_failed", source_id=src.id)
        logger.info("document_batch_done", total_sources=len(sources), total_chunks=len(all_docs))
        return all_docs

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------

    def chunk(self, text: str, options: ChunkOptions | None = None) -> list[str]:
        opts = options or self._options
        if opts.chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        if opts.chunk_overlap < 0:
            raise ValueError("chunk_overlap must be non-negative")
        if opts.chunk_overlap >= opts.chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        if not text or not text.strip():
            return []
        if len(text) <= opts.chunk_size:
            return [text.strip()]

        separator = opts.separator or ""
        segments = text.split(separator) if separator else [text]
        chunks: list[str] = []
        current = ""

        for seg in segments:
            seg_with_sep = seg + separator
            if len(seg_with_sep) > opts.chunk_size:
                if current.strip():
                    chunks.append(current.strip())
                    current = self._overlap_tail(current, opts.chunk_overlap)
                forced = self._force_chunk(seg_with_sep, opts.chunk_size, opts.chunk_overlap)
                chunks.extend(forced[:-1])
                current = forced[-1] if forced else ""
            elif len(current) + len(seg_with_sep) > opts.chunk_size:
                if current.strip():
                    chunks.append(current.strip())
                current = self._overlap_tail(current, opts.chunk_overlap) + seg_with_sep
            else:
                current += seg_with_sep

        if current.strip():
            chunks.append(current.strip())
        return chunks

    @staticmethod
    def _force_chunk(text: str, size: int, overlap: int) -> list[str]:
        step = size - overlap
        chunks: list[str] = []
        start = 0
        while start < len(text):
            piece = text[start : start + size].strip()
            if piece:
                chunks.append(piece)
            start += step
        return chunks

    @staticmethod
    def _overlap_tail(text: str, overlap: int) -> str:
        if overlap <= 0 or len(text) <= overlap:
            return ""
        return text[-overlap:]

    def get_options(self) -> ChunkOptions:
        return ChunkOptions(
            chunk_size=self._options.chunk_size,
            chunk_overlap=self._options.chunk_overlap,
            separator=self._options.separator,
        )

    def update_options(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._options, k):
                setattr(self._options, k, v)
        logger.info("document_processor_options_updated")
