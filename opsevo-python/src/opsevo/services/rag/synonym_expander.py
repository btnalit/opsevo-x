"""SynonymExpander — expands query terms with synonyms.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

_SYNONYMS: dict[str, list[str]] = {
    "cpu": ["processor", "load"],
    "memory": ["ram", "mem"],
    "interface": ["port", "link", "eth"],
    "firewall": ["filter", "acl"],
    "route": ["routing", "gateway"],
    "dns": ["nameserver", "resolver"],
    "bandwidth": ["throughput", "speed"],
    "latency": ["delay", "ping"],
    "error": ["fault", "failure", "issue"],
    "alert": ["alarm", "warning", "notification"],
}


class SynonymExpander:
    def __init__(self, extra_synonyms: dict[str, list[str]] | None = None):
        self._synonyms = dict(_SYNONYMS)
        if extra_synonyms:
            self._synonyms.update(extra_synonyms)

    def expand(self, query: str) -> str:
        words = query.lower().split()
        expanded = list(words)
        for w in words:
            if w in self._synonyms:
                expanded.extend(self._synonyms[w])
        return " ".join(dict.fromkeys(expanded))  # deduplicate preserving order
