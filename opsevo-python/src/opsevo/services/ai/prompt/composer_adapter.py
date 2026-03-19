"""PromptComposerAdapter — bridges PromptComposer with the AI service layer.

Requirements: 11.5
"""

from __future__ import annotations

from typing import Any

from opsevo.services.ai.prompt.composer import PromptComposer
from opsevo.services.ai.prompt.legacy_templates import get_legacy_template


class PromptComposerAdapter:
    def __init__(self, composer: PromptComposer):
        self._composer = composer

    def build_system_prompt(self, context: dict[str, Any] | None = None) -> str:
        try:
            prompt = self._composer.compose(context)
            if prompt:
                return prompt
        except Exception:
            pass
        # Fallback to legacy template
        return get_legacy_template(context)
