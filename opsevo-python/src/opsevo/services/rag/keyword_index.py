"""KeywordIndexManager — inverted index for keyword-based search with BM25 scoring.

Requirements: 10.4
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class KeywordIndexConfig:
    persist_path: str = ""
    k1: float = 1.2
    b: float = 0.75
    fuzzy_threshold: int = 2


@dataclass
class KeywordSearchResult:
    entry_id: str
    score: float
    matched_terms: list[str] = field(default_factory=list)


@dataclass
class InvertedIndexItem:
    entry_ids: dict[str, float] = field(default_factory=dict)  # entry_id -> tf


class KeywordIndexManager:
    def __init__(self, config: KeywordIndexConfig | None = None):
        self._config = config or KeywordIndexConfig()
        self._index: dict[str, InvertedIndexItem] = {}
        self._doc_lengths: dict[str, int] = {}
        self._avg_doc_length: float = 0.0
        self._initialized = False

    async def initialize(self) -> None:
        if self._config.persist_path:
            await self.load()
        self._initialized = True
        logger.info("keyword_index_initialized", entries=len(self._doc_lengths))

    def is_initialized(self) -> bool:
        return self._initialized

    def _ensure_initialized(self) -> None:
        if not self._initialized:
            raise RuntimeError("KeywordIndexManager not initialized")

    def add_entry(self, entry_id: str, fields: dict[str, str | list[str]]) -> None:
        self._ensure_initialized()
        tokens = self._fields_to_tokens(fields)
        if not tokens:
            return
        self._doc_lengths[entry_id] = len(tokens)
        tf: Counter[str] = Counter(tokens)
        for term, count in tf.items():
            if term not in self._index:
                self._index[term] = InvertedIndexItem()
            self._index[term].entry_ids[entry_id] = count / len(tokens)
        self._update_avg_doc_length()

    def remove_entry(self, entry_id: str) -> None:
        self._ensure_initialized()
        for item in self._index.values():
            item.entry_ids.pop(entry_id, None)
        self._doc_lengths.pop(entry_id, None)
        self._update_avg_doc_length()

    def update_entry(self, entry_id: str, fields: dict[str, str | list[str]]) -> None:
        self.remove_entry(entry_id)
        self.add_entry(entry_id, fields)

    def has_entry(self, entry_id: str) -> bool:
        return entry_id in self._doc_lengths

    def search(self, query: str, limit: int = 10) -> list[KeywordSearchResult]:
        self._ensure_initialized()
        terms = self._tokenize(query)
        if not terms:
            return []
        scores: dict[str, float] = {}
        matched: dict[str, list[str]] = {}
        n = len(self._doc_lengths)
        for term in terms:
            item = self._index.get(term) or self._fuzzy_match(term)
            if not item:
                continue
            df = len(item.entry_ids)
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
            for eid, tf in item.entry_ids.items():
                dl = self._doc_lengths.get(eid, 1)
                numerator = tf * (self._config.k1 + 1)
                denominator = tf + self._config.k1 * (1 - self._config.b + self._config.b * dl / max(self._avg_doc_length, 1))
                score = idf * numerator / denominator
                scores[eid] = scores.get(eid, 0) + score
                matched.setdefault(eid, []).append(term)

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:limit]
        return [
            KeywordSearchResult(entry_id=eid, score=s, matched_terms=matched.get(eid, []))
            for eid, s in ranked
        ]

    def _fuzzy_match(self, term: str) -> InvertedIndexItem | None:
        best: str | None = None
        best_dist = self._config.fuzzy_threshold + 1
        for indexed_term in self._index:
            if abs(len(indexed_term) - len(term)) > self._config.fuzzy_threshold:
                continue
            d = self._levenshtein(term, indexed_term)
            if d < best_dist:
                best_dist = d
                best = indexed_term
        if best is not None and best_dist <= self._config.fuzzy_threshold:
            return self._index[best]
        return None

    @staticmethod
    def _levenshtein(s1: str, s2: str) -> int:
        if len(s1) < len(s2):
            return KeywordIndexManager._levenshtein(s2, s1)
        if not s2:
            return len(s1)
        prev = list(range(len(s2) + 1))
        for i, c1 in enumerate(s1):
            curr = [i + 1]
            for j, c2 in enumerate(s2):
                curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (0 if c1 == c2 else 1)))
            prev = curr
        return prev[-1]

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        words = re.findall(r"[a-zA-Z\u4e00-\u9fff]{2,}", text.lower())
        stop = {"the", "and", "for", "that", "this", "with", "from", "are", "was", "were"}
        return [w for w in words if w not in stop]

    def _fields_to_tokens(self, fields: dict[str, str | list[str]]) -> list[str]:
        parts: list[str] = []
        for v in fields.values():
            if isinstance(v, list):
                parts.extend(v)
            else:
                parts.append(v)
        return self._tokenize(" ".join(parts))

    def _update_avg_doc_length(self) -> None:
        lengths = self._doc_lengths.values()
        self._avg_doc_length = sum(lengths) / len(lengths) if lengths else 0.0

    async def persist(self) -> None:
        if not self._config.persist_path:
            return
        data = {
            "index": {t: {"entry_ids": item.entry_ids} for t, item in self._index.items()},
            "doc_lengths": self._doc_lengths,
        }
        Path(self._config.persist_path).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        logger.info("keyword_index_persisted", terms=len(self._index))

    async def load(self) -> None:
        p = Path(self._config.persist_path)
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            for term, item_data in data.get("index", {}).items():
                self._index[term] = InvertedIndexItem(entry_ids=item_data.get("entry_ids", {}))
            self._doc_lengths = data.get("doc_lengths", {})
            self._update_avg_doc_length()
            logger.info("keyword_index_loaded", terms=len(self._index))
        except Exception:
            logger.error("keyword_index_load_failed")

    async def rebuild(self, entries: list[dict[str, Any]]) -> None:
        self._index.clear()
        self._doc_lengths.clear()
        for entry in entries:
            fields: dict[str, str | list[str]] = {
                "title": entry.get("title", ""),
                "content": entry.get("content", ""),
            }
            tags = entry.get("metadata", {}).get("tags", [])
            if tags:
                fields["tags"] = tags
            self.add_entry(entry["id"], fields)
        await self.persist()
        logger.info("keyword_index_rebuilt", entries=len(entries))

    def get_stats(self) -> dict[str, Any]:
        return {
            "total_terms": len(self._index),
            "total_entries": len(self._doc_lengths),
            "avg_doc_length": round(self._avg_doc_length, 2),
            "initialized": self._initialized,
        }

    def get_config(self) -> KeywordIndexConfig:
        return KeywordIndexConfig(
            persist_path=self._config.persist_path,
            k1=self._config.k1,
            b=self._config.b,
            fuzzy_threshold=self._config.fuzzy_threshold,
        )
