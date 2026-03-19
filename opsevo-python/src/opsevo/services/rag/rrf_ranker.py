"""RRF (Reciprocal Rank Fusion) ranker.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

from typing import Any


def rrf_merge(
    *result_lists: list[dict[str, Any]],
    k: int = 60,
    id_key: str = "id",
    top_n: int = 10,
) -> list[dict[str, Any]]:
    """Merge multiple ranked lists using Reciprocal Rank Fusion."""
    scores: dict[str, float] = {}
    items: dict[str, dict] = {}

    for results in result_lists:
        for rank, item in enumerate(results):
            item_id = str(item.get(id_key, rank))
            scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (k + rank + 1)
            items[item_id] = item

    sorted_ids = sorted(scores, key=lambda x: scores[x], reverse=True)
    merged = []
    for item_id in sorted_ids[:top_n]:
        entry = dict(items[item_id])
        entry["rrf_score"] = scores[item_id]
        merged.append(entry)
    return merged
