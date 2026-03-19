"""ResponseGenerator — LLM-driven response generation from ReAct results.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from opsevo.services.rag.tool_output_summarizer import ToolOutputSummarizer
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ResponseGeneratorConfig:
    timeout: int = 90000
    max_response_length: int = 8000
    include_tool_details: bool = True
    include_suggestions: bool = True


@dataclass
class ToolResultSummary:
    tool_name: str
    success: bool
    summary: str
    key_data: dict[str, Any] = field(default_factory=dict)


class ResponseGenerator:
    def __init__(self, config: ResponseGeneratorConfig | None = None):
        self._config = config or ResponseGeneratorConfig()
        self._ai_adapter: Any = None
        self._provider: str = ""
        self._model: str = ""
        self._summarizer = ToolOutputSummarizer(max_chars_per_output=2000)

    def set_ai_adapter(self, adapter: Any, provider: str = "", model: str = "") -> None:
        self._ai_adapter = adapter
        self._provider = provider
        self._model = model
        logger.info("response_generator_adapter_set", provider=provider, model=model)

    def has_ai_adapter(self) -> bool:
        return self._ai_adapter is not None

    async def generate_final_answer(
        self,
        message: str,
        steps: list[dict[str, Any]],
        rag_context: dict[str, Any] | None = None,
        conversation: list[dict[str, str]] | None = None,
    ) -> str:
        if not self._ai_adapter:
            return self.generate_fallback_response(message, steps, rag_context)
        try:
            prompt = self._build_prompt(message, steps, rag_context)
            memory = conversation or []
            result = await self._call_llm(prompt, memory)
            return self._post_process(result, steps)
        except Exception:
            logger.warning("response_generator_llm_failed")
            return self.generate_fallback_response(message, steps, rag_context)

    def generate_fallback_response(
        self,
        message: str,
        steps: list[dict[str, Any]],
        rag_context: dict[str, Any] | None = None,
    ) -> str:
        tool_results = self._extract_tool_results(steps)
        if not tool_results:
            return self._generate_no_results_response(message, steps)
        parts: list[str] = []
        for tr in tool_results:
            status = "✓" if tr.success else "✗"
            parts.append(f"{status} {tr.tool_name}: {tr.summary}")
        if rag_context:
            knowledge = rag_context.get("knowledge", [])
            if knowledge:
                parts.append(f"\nRelevant knowledge: {len(knowledge)} entries found")
        suggestions = self._generate_suggestions(message, tool_results)
        if suggestions:
            parts.append("\nSuggestions:")
            parts.extend(f"  - {s}" for s in suggestions)
        return "\n".join(parts)

    def _build_prompt(
        self,
        message: str,
        steps: list[dict[str, Any]],
        rag_context: dict[str, Any] | None = None,
    ) -> str:
        parts = [
            "You are a network operations assistant. Based on the tool execution results below, "
            "provide a clear, actionable response to the user's query.",
            f"\n## User Query\n{message}",
        ]
        if rag_context:
            ctx = self._format_rag_context(rag_context)
            if ctx:
                parts.append(f"\n## Knowledge Context\n{ctx}")
        results_text = self._format_results(steps)
        if results_text:
            parts.append(f"\n## Tool Execution Results\n{results_text}")
        parts.append(
            "\n## Instructions\n"
            "Synthesize the information above into a helpful response. "
            "Include specific data from tool results. Be concise but thorough."
        )
        return "\n".join(parts)

    @staticmethod
    def _format_rag_context(rag_context: dict[str, Any]) -> str:
        knowledge = rag_context.get("knowledge", [])
        if not knowledge:
            return ""
        lines: list[str] = []
        for i, k in enumerate(knowledge[:5], 1):
            content = str(k.get("content", ""))[:300]
            lines.append(f"[{i}] {content}")
        return "\n".join(lines)

    def _format_results(self, steps: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        obs_idx = 0
        for step in steps:
            step_type = step.get("type", "")
            if step_type == "action":
                tool = step.get("tool", "unknown")
                lines.append(f"Action: {tool}")
            elif step_type == "observation":
                obs_idx += 1
                output = step.get("output", "")
                summarized = self._summarizer.summarize(str(output))
                lines.append(f"Observation {obs_idx}: {summarized}")
        return "\n".join(lines)

    async def _call_llm(self, prompt: str, conversation: list[dict[str, str]]) -> str:
        messages = list(conversation) + [{"role": "user", "content": prompt}]
        resp = await self._ai_adapter.chat(messages)
        if isinstance(resp, dict):
            return resp.get("content", "")
        return str(resp)

    def _post_process(self, response: str, steps: list[dict[str, Any]]) -> str:
        if len(response) > self._config.max_response_length:
            response = response[: self._config.max_response_length] + "..."
        return response.strip()

    def _extract_tool_results(self, steps: list[dict[str, Any]]) -> list[ToolResultSummary]:
        results: list[ToolResultSummary] = []
        for i, step in enumerate(steps):
            if step.get("type") == "observation":
                tool_name = self._find_tool_name(steps, i)
                output = step.get("output", "")
                success = step.get("success", True)
                summary = self._summarizer.summarize(str(output))
                key_data = self._extract_key_data(output)
                results.append(ToolResultSummary(
                    tool_name=tool_name, success=success,
                    summary=summary, key_data=key_data,
                ))
        return results

    @staticmethod
    def _find_tool_name(steps: list[dict[str, Any]], obs_index: int) -> str:
        for i in range(obs_index - 1, -1, -1):
            if steps[i].get("type") == "action":
                return steps[i].get("tool", "unknown")
        return "unknown"

    @staticmethod
    def _extract_key_data(output: Any) -> dict[str, Any]:
        if isinstance(output, dict):
            return {k: v for k, v in output.items() if k in ("status", "count", "total", "name", "id")}
        return {}

    @staticmethod
    def _generate_no_results_response(message: str, steps: list[dict[str, Any]]) -> str:
        if not steps:
            return f"I wasn't able to find relevant information for: {message}"
        return f"The tools were executed but produced no actionable results for: {message}"

    @staticmethod
    def _generate_suggestions(message: str, results: list[ToolResultSummary]) -> list[str]:
        suggestions: list[str] = []
        failed = [r for r in results if not r.success]
        if failed:
            suggestions.append(f"Retry failed operations: {', '.join(r.tool_name for r in failed)}")
        return suggestions

    def get_config(self) -> ResponseGeneratorConfig:
        return ResponseGeneratorConfig(
            timeout=self._config.timeout,
            max_response_length=self._config.max_response_length,
            include_tool_details=self._config.include_tool_details,
            include_suggestions=self._config.include_suggestions,
        )

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        logger.info("response_generator_config_updated")
