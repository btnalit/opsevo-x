"""ScriptSynthesizer — synthesize remediation scripts from plans.

Used by FaultHealer and RuleEvolutionService.
Requirements: 9.9
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ScriptSynthesizer:
    def __init__(self) -> None:
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def synthesize(self, plan: dict[str, Any], script_language: str = "bash") -> dict[str, Any]:
        if self._ai_adapter:
            try:
                prompt = (
                    f"Generate a {script_language} remediation script for:\n"
                    f"Plan: {plan.get('description', '')}\n"
                    f"Steps: {plan.get('steps', [])}\n"
                    f"Return only the script code."
                )
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                return {"script": content, "language": script_language, "source": "ai"}
            except Exception:
                logger.warning("script_synthesis_ai_failed")
        return self._template_synthesis(plan, script_language)

    @staticmethod
    def _template_synthesis(plan: dict[str, Any], language: str) -> dict[str, Any]:
        steps = plan.get("steps", [])
        if language == "routeros":
            lines = [f"# Step {i+1}: {s}" for i, s in enumerate(steps)]
        else:
            lines = [f"#!/bin/bash", f"# Remediation script"] + [f"echo 'Step {i+1}: {s}'" for i, s in enumerate(steps)]
        return {"script": "\n".join(lines), "language": language, "source": "template"}
