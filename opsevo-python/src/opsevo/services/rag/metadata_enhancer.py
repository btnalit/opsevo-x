"""MetadataEnhancer — auto-generate keywords, questions, synonyms for knowledge entries.

Requirements: 10.4
"""

from __future__ import annotations

import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class EnhancedMetadata:
    auto_keywords: list[str] = field(default_factory=list)
    question_examples: list[str] = field(default_factory=list)
    auto_synonyms: dict[str, list[str]] = field(default_factory=dict)
    searchable_text: str = ""
    enhanced_at: int = 0
    enhancement_source: str = "fallback"


@dataclass
class MetadataEnhancerConfig:
    max_keywords: int = 15
    max_questions: int = 5
    use_llm: bool = False


class MetadataEnhancer:
    def __init__(self, config: MetadataEnhancerConfig | None = None):
        self._config = config or MetadataEnhancerConfig()
        self._ai_adapter: Any = None
        self._doc_freq: Counter[str] = Counter()
        self._total_docs: int = 0

    def set_ai_adapter(self, adapter: Any, provider: str = "", model: str = "") -> None:
        self._ai_adapter = adapter
        logger.info("metadata_enhancer_adapter_set", provider=provider, model=model)

    async def enhance(self, entry: dict[str, Any]) -> EnhancedMetadata:
        if self._config.use_llm and self._ai_adapter:
            try:
                return await self._enhance_with_llm(entry)
            except Exception:
                logger.warning("metadata_llm_fallback", entry_id=entry.get("id"))
        return self.enhance_fallback(entry)

    async def _enhance_with_llm(self, entry: dict[str, Any]) -> EnhancedMetadata:
        title = entry.get("title", "")
        content = entry.get("content", "")[:2000]
        prompt = (
            f"Analyze this knowledge entry and return JSON with keys: "
            f"keywords (list[str]), questions (list[str]), synonyms (dict[str,list[str]]).\n\n"
            f"Title: {title}\nContent: {content}"
        )
        resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
        text = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        parsed = self._parse_llm_response(text)
        searchable = self._build_searchable_text(
            title, content, parsed.get("keywords", []), parsed.get("questions", [])
        )
        return EnhancedMetadata(
            auto_keywords=parsed.get("keywords", [])[:self._config.max_keywords],
            question_examples=parsed.get("questions", [])[:self._config.max_questions],
            auto_synonyms=parsed.get("synonyms", {}),
            searchable_text=searchable,
            enhanced_at=int(time.time() * 1000),
            enhancement_source="llm",
        )

    @staticmethod
    def _parse_llm_response(text: str) -> dict[str, Any]:
        import json
        try:
            start = text.index("{")
            end = text.rindex("}") + 1
            return json.loads(text[start:end])
        except Exception:
            return {}

    def enhance_fallback(self, entry: dict[str, Any]) -> EnhancedMetadata:
        title = entry.get("title", "")
        content = entry.get("content", "")
        keywords = self._extract_keywords_tfidf(content)
        questions = self._generate_simple_questions(title, keywords)
        synonyms = self._generate_simple_synonyms(keywords)
        searchable = self._build_searchable_text(title, content, keywords, questions)
        return EnhancedMetadata(
            auto_keywords=keywords[:self._config.max_keywords],
            question_examples=questions[:self._config.max_questions],
            auto_synonyms=synonyms,
            searchable_text=searchable,
            enhanced_at=int(time.time() * 1000),
            enhancement_source="fallback",
        )

    def _extract_keywords_tfidf(self, text: str) -> list[str]:
        tokens = self._tokenize(text)
        if not tokens:
            return []
        tf: Counter[str] = Counter(tokens)
        total = len(tokens)
        scored: list[tuple[str, float]] = []
        for term, count in tf.items():
            tf_val = count / total
            df = self._doc_freq.get(term, 0)
            idf = math.log((self._total_docs + 1) / (df + 1)) + 1 if self._total_docs > 0 else 1.0
            scored.append((term, tf_val * idf))
        scored.sort(key=lambda x: x[1], reverse=True)
        return [t for t, _ in scored[:self._config.max_keywords]]

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        words = re.findall(r"[a-zA-Z\u4e00-\u9fff]{2,}", text.lower())
        stop = {"the", "and", "for", "that", "this", "with", "from", "are", "was", "were", "been", "have", "has"}
        return [w for w in words if w not in stop]

    @staticmethod
    def _generate_simple_questions(title: str, keywords: list[str]) -> list[str]:
        qs: list[str] = []
        if title:
            qs.append(f"What is {title}?")
            qs.append(f"How does {title} work?")
        for kw in keywords[:3]:
            qs.append(f"What about {kw}?")
        return qs

    @staticmethod
    def _generate_simple_synonyms(keywords: list[str]) -> dict[str, list[str]]:
        mapping: dict[str, list[str]] = {}
        for kw in keywords[:5]:
            mapping[kw] = [kw.upper(), kw.capitalize()]
        return mapping

    @staticmethod
    def _build_searchable_text(
        title: str, content: str, keywords: list[str], questions: list[str]
    ) -> str:
        parts = [title, content[:500], " ".join(keywords), " ".join(questions)]
        return " ".join(p for p in parts if p)

    async def enhance_batch(self, entries: list[dict[str, Any]]) -> list[EnhancedMetadata]:
        self._update_doc_freq(entries)
        results: list[EnhancedMetadata] = []
        for entry in entries:
            results.append(await self.enhance(entry))
        return results

    def _update_doc_freq(self, entries: list[dict[str, Any]]) -> None:
        self._total_docs += len(entries)
        for entry in entries:
            tokens = set(self._tokenize(entry.get("content", "")))
            for t in tokens:
                self._doc_freq[t] += 1

    def get_config(self) -> MetadataEnhancerConfig:
        return MetadataEnhancerConfig(
            max_keywords=self._config.max_keywords,
            max_questions=self._config.max_questions,
            use_llm=self._config.use_llm,
        )

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        logger.info("metadata_enhancer_config_updated")
