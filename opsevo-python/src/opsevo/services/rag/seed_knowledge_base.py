"""Seed knowledge base — loads initial knowledge from data files.

Requirements: 10.9
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
from opsevo.services.rag.knowledge_base import KnowledgeBase
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

async def seed_knowledge(kb: KnowledgeBase, data_dir: str = "data/ai-ops/knowledge-seed") -> int:
    p = Path(data_dir)
    if not p.exists():
        return 0
    count = 0
    for f in p.glob("*.json"):
        try:
            entries = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(entries, list):
                for e in entries:
                    await kb.add_entry(e.get("content", str(e)), e.get("metadata"))
                    count += 1
        except Exception as exc:
            logger.warning("seed_file_failed", file=str(f), error=str(exc))
    logger.info("knowledge_seeded", count=count)
    return count
