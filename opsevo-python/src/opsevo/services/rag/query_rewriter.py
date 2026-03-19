"""QueryRewriter — rewrites user queries for better retrieval.

Requirements: 10.1, 10.6
"""

from __future__ import annotations


class QueryRewriter:
    def rewrite(self, query: str) -> str:
        q = query.strip()
        if not q:
            return q
        # Remove common filler words for better search
        stopwords = {"please", "can", "you", "help", "me", "with", "the", "a", "an", "is", "are"}
        words = q.split()
        filtered = [w for w in words if w.lower() not in stopwords]
        return " ".join(filtered) if filtered else q
