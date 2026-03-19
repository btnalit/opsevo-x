"""FileProcessor — multi-format file parsing and knowledge entry generation.

Requirements: 10.4
"""

from __future__ import annotations

import hashlib
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from opsevo.services.rag.knowledge_base import KnowledgeBase
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

SUPPORTED_FILE_TYPES: dict[str, list[str]] = {
    "text/plain": [".txt", ".log", ".conf", ".cfg"],
    "text/markdown": [".md", ".markdown"],
    "text/csv": [".csv"],
    "application/json": [".json"],
    "application/yaml": [".yaml", ".yml"],
    "application/pdf": [".pdf"],
}


@dataclass
class UploadedFile:
    filename: str
    content: bytes
    content_type: str
    size: int


@dataclass
class ProcessedFileResult:
    filename: str
    success: bool
    entries_created: int = 0
    error: str | None = None
    chunks: list[str] = field(default_factory=list)


@dataclass
class KnowledgeEntrySchema:
    title: str
    content: str
    source: str = "upload"
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


# ------------------------------------------------------------------
# Parsers
# ------------------------------------------------------------------

class FileParser(ABC):
    @abstractmethod
    def supports(self, ext: str) -> bool: ...

    @abstractmethod
    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]: ...


class TextParser(FileParser):
    def supports(self, ext: str) -> bool:
        return ext in {".txt", ".log", ".conf", ".cfg"}

    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]:
        text = content.decode("utf-8", errors="replace")
        return [KnowledgeEntrySchema(title=filename, content=text, tags=["text"])]


class MarkdownParser(FileParser):
    _HEADING = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)

    def supports(self, ext: str) -> bool:
        return ext in {".md", ".markdown"}

    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]:
        text = content.decode("utf-8", errors="replace")
        sections = self._split_sections(text)
        if not sections:
            return [KnowledgeEntrySchema(title=filename, content=text, tags=["markdown"])]
        return [
            KnowledgeEntrySchema(title=title, content=body.strip(), tags=["markdown"])
            for title, body in sections
            if body.strip()
        ]

    def _split_sections(self, text: str) -> list[tuple[str, str]]:
        matches = list(self._HEADING.finditer(text))
        if not matches:
            return []
        sections: list[tuple[str, str]] = []
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            sections.append((m.group(2).strip(), text[m.end() : end]))
        return sections


class JsonParser(FileParser):
    def supports(self, ext: str) -> bool:
        return ext == ".json"

    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]:
        import json
        text = content.decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
            pretty = json.dumps(data, ensure_ascii=False, indent=2)
        except Exception:
            pretty = text
        return [KnowledgeEntrySchema(title=filename, content=pretty, tags=["json"])]


class YamlParser(FileParser):
    def supports(self, ext: str) -> bool:
        return ext in {".yaml", ".yml"}

    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]:
        text = content.decode("utf-8", errors="replace")
        return [KnowledgeEntrySchema(title=filename, content=text, tags=["yaml"])]


class CsvParser(FileParser):
    def supports(self, ext: str) -> bool:
        return ext == ".csv"

    def parse(self, content: bytes, filename: str) -> list[KnowledgeEntrySchema]:
        text = content.decode("utf-8", errors="replace")
        return [KnowledgeEntrySchema(title=filename, content=text, tags=["csv"])]


# ------------------------------------------------------------------
# FileProcessor
# ------------------------------------------------------------------

class FileProcessor:
    def __init__(self, knowledge_base: KnowledgeBase | None = None):
        self._kb = knowledge_base
        self._parsers: list[FileParser] = [
            TextParser(), MarkdownParser(), JsonParser(), YamlParser(), CsvParser(),
        ]
        self._initialized = False

    async def initialize(self) -> None:
        self._initialized = True
        logger.info("file_processor_initialized")

    def is_initialized(self) -> bool:
        return self._initialized

    def get_supported_types(self) -> dict[str, list[str]]:
        return dict(SUPPORTED_FILE_TYPES)

    def validate_files(self, files: list[UploadedFile]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        all_exts = {e for exts in SUPPORTED_FILE_TYPES.values() for e in exts}
        for f in files:
            ext = Path(f.filename).suffix.lower()
            results.append({
                "filename": f.filename,
                "valid": ext in all_exts,
                "size": f.size,
            })
        return results

    async def process_file(self, uploaded: UploadedFile) -> ProcessedFileResult:
        ext = Path(uploaded.filename).suffix.lower()
        parser = self._find_parser(ext)
        if parser is None:
            return ProcessedFileResult(filename=uploaded.filename, success=False, error="Unsupported file type")
        try:
            entries = parser.parse(uploaded.content, uploaded.filename)
            created = 0
            chunks: list[str] = []
            for entry in entries:
                if self._kb:
                    await self._kb.add_entry(entry.content, entry.metadata, entry.tags)
                    created += 1
                chunks.append(entry.content[:200])
            return ProcessedFileResult(filename=uploaded.filename, success=True, entries_created=created, chunks=chunks)
        except Exception as exc:
            logger.error("file_process_failed", filename=uploaded.filename, error=str(exc))
            return ProcessedFileResult(filename=uploaded.filename, success=False, error=str(exc))

    def _find_parser(self, ext: str) -> FileParser | None:
        for p in self._parsers:
            if p.supports(ext):
                return p
        return None
