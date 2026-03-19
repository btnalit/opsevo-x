"""Token estimation and truncation utilities.

Mirrors the behaviour of the TypeScript ``tokenUtils.ts``:

* Chinese characters (CJK Unified Ideographs) count as **1 token each**.
* Remaining text is split into whitespace-delimited words, each counting as
  **1 token**.
* ``truncate_to_tokens`` walks the string character-by-character using the
  same heuristic as the TS version.

Requirements: 20.2
"""

from __future__ import annotations

import re

_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")


def count_tokens(text: str) -> int:
    """Estimate the number of tokens in *text*.

    Rules (matching TS ``estimateTokens``):
    - Each CJK character ≈ 1 token
    - Each whitespace-delimited word in the remaining text ≈ 1 token
    """
    if not text:
        return 0

    cjk_chars = _CJK_RE.findall(text)
    tokens = len(cjk_chars)

    without_cjk = _CJK_RE.sub(" ", text)
    words = without_cjk.split()
    tokens += len(words)

    return tokens


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """Truncate *text* so that it fits within *max_tokens*.

    Uses the same character-walking heuristic as the TS ``truncateToTokens``:
    - CJK character → +1 token
    - Whitespace → skip (no token cost)
    - Other character → +1 token every 4 characters

    If the text already fits, it is returned unchanged.
    """
    if max_tokens <= 0:
        return ""

    if count_tokens(text) <= max_tokens:
        return text

    tokens = 0
    end_index = 0

    for i, char in enumerate(text):
        if _CJK_RE.match(char):
            tokens += 1
        elif char.isspace():
            pass  # whitespace doesn't count
        else:
            if i % 4 == 0:
                tokens += 1

        if tokens >= max_tokens:
            end_index = i
            break
        end_index = i

    return text[: end_index + 1] + "..."
