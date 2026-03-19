"""HybridSearchMigration — migrate existing knowledge entries with metadata enhancement.

Requirements: 10.4
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from opsevo.services.rag.keyword_index import KeywordIndexManager
from opsevo.services.rag.metadata_enhancer import MetadataEnhancer
from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class MigrationConfig:
    batch_size: int = 10
    skip_enhanced: bool = True
    force_re_enhance: bool = False
    progress_interval: int = 5


@dataclass
class MigrationResult:
    total: int = 0
    success: int = 0
    failed: int = 0
    skipped: int = 0
    failed_ids: list[str] = field(default_factory=list)
    duration: int = 0


@dataclass
class MigrationProgress:
    current: int = 0
    total: int = 0
    success: int = 0
    failed: int = 0
    percentage: int = 0
    estimated_remaining: int = 0


@dataclass
class VerificationResult:
    passed: bool = True
    total_entries: int = 0
    enhanced_entries: int = 0
    indexed_entries: int = 0
    issues: list[str] = field(default_factory=list)


class HybridSearchMigration:
    def __init__(
        self,
        datastore: DataStore,
        enhancer: MetadataEnhancer,
        keyword_index: KeywordIndexManager,
        config: MigrationConfig | None = None,
    ):
        self._ds = datastore
        self._enhancer = enhancer
        self._keyword_index = keyword_index
        self._config = config or MigrationConfig()

    async def migrate_all(
        self, on_progress: Callable[[MigrationProgress], None] | None = None
    ) -> MigrationResult:
        start = int(time.time() * 1000)
        entries = await self._ds.query("SELECT id, title, content, metadata FROM knowledge_embeddings")
        result = MigrationResult(total=len(entries))

        to_migrate = entries
        if self._config.skip_enhanced and not self._config.force_re_enhance:
            to_migrate = [e for e in entries if not (e.get("metadata") or {}).get("enhancedAt")]
            result.skipped = len(entries) - len(to_migrate)

        for i in range(0, len(to_migrate), self._config.batch_size):
            batch = to_migrate[i : i + self._config.batch_size]
            for entry in batch:
                try:
                    await self.migrate_entry(entry)
                    result.success += 1
                except Exception:
                    result.failed += 1
                    result.failed_ids.append(entry.get("id", ""))
                    logger.error("migration_entry_failed", entry_id=entry.get("id"))

            if on_progress and (i + self._config.batch_size) % (self._config.progress_interval * self._config.batch_size) == 0:
                current = min(i + self._config.batch_size, len(to_migrate)) + result.skipped
                elapsed = int(time.time() * 1000) - start
                avg = elapsed / max(current, 1)
                remaining = len(to_migrate) - min(i + self._config.batch_size, len(to_migrate))
                on_progress(MigrationProgress(
                    current=current, total=len(entries),
                    success=result.success, failed=result.failed,
                    percentage=round(current / max(len(entries), 1) * 100),
                    estimated_remaining=round(avg * remaining),
                ))

        await self._keyword_index.persist()
        result.duration = int(time.time() * 1000) - start
        logger.info("migration_completed", **{
            "total": result.total, "success": result.success,
            "failed": result.failed, "skipped": result.skipped,
            "duration": result.duration,
        })
        return result

    async def migrate_entry(self, entry: dict[str, Any]) -> None:
        enhanced = await self._enhancer.enhance(entry)
        meta = entry.get("metadata") or {}
        meta.update({
            "autoKeywords": enhanced.auto_keywords,
            "questionExamples": enhanced.question_examples,
            "autoSynonyms": enhanced.auto_synonyms,
            "searchableText": enhanced.searchable_text,
            "enhancedAt": enhanced.enhanced_at,
            "enhancementSource": enhanced.enhancement_source,
        })
        import json
        await self._ds.execute(
            "UPDATE knowledge_embeddings SET metadata = $1 WHERE id = $2",
            (json.dumps(meta, ensure_ascii=False), entry["id"]),
        )
        self._keyword_index.update_entry(entry["id"], {
            "title": entry.get("title", ""),
            "content": entry.get("content", ""),
            "tags": (entry.get("metadata") or {}).get("tags", []),
            "autoKeywords": enhanced.auto_keywords,
            "questionExamples": enhanced.question_examples,
        })

    async def verify(self) -> VerificationResult:
        entries = await self._ds.query("SELECT id, metadata FROM knowledge_embeddings")
        issues: list[str] = []
        enhanced_count = 0
        indexed_count = 0
        for e in entries:
            meta = e.get("metadata") or {}
            if meta.get("enhancedAt"):
                enhanced_count += 1
                if not meta.get("autoKeywords"):
                    issues.append(f"Entry {e['id']} has no autoKeywords")
            else:
                issues.append(f"Entry {e['id']} not enhanced")
            if self._keyword_index.has_entry(e["id"]):
                indexed_count += 1
            else:
                issues.append(f"Entry {e['id']} not in keyword index")
        return VerificationResult(
            passed=len(issues) == 0,
            total_entries=len(entries),
            enhanced_entries=enhanced_count,
            indexed_entries=indexed_count,
            issues=issues,
        )

    async def get_unenhanced_entries(self) -> list[str]:
        entries = await self._ds.query("SELECT id, metadata FROM knowledge_embeddings")
        return [e["id"] for e in entries if not (e.get("metadata") or {}).get("enhancedAt")]

    async def get_migration_stats(self) -> dict[str, int]:
        entries = await self._ds.query("SELECT id, metadata FROM knowledge_embeddings")
        enhanced = sum(1 for e in entries if (e.get("metadata") or {}).get("enhancedAt"))
        indexed = sum(1 for e in entries if self._keyword_index.has_entry(e["id"]))
        return {"total": len(entries), "enhanced": enhanced, "indexed": indexed, "pending": len(entries) - enhanced}
