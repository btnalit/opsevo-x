"""ReactLoopController — ReAct reasoning loop (device-agnostic).

Integrates all sub-components: prompt building, knowledge retrieval,
output validation, failure handling, parallel execution, final answer extraction.

Requirements: 10.2, 1.8, 1.9
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

from opsevo.services.ai.adapters.base import AIAdapter
from opsevo.services.rag.react_failure import ReactFailureHandler
from opsevo.services.rag.react_final import extract_final_answer
from opsevo.services.rag.react_knowledge import format_knowledge_for_react
from opsevo.services.rag.react_parallel import execute_parallel_actions
from opsevo.services.rag.react_prompt import build_react_system_prompt
from opsevo.services.rag.react_tools import ReactToolExecutor
from opsevo.services.rag.react_validator import ReactValidator
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

MAX_ITERATIONS = 10
_DUPLICATE_WINDOW = 3  # look-back window for loop detection


class ReactLoopController:
    """Full-featured ReAct loop with knowledge, validation, failure handling."""

    def __init__(
        self,
        adapter: AIAdapter,
        tool_executor: ReactToolExecutor,
        script_language: str = "",
        *,
        knowledge_entries: list[dict[str, Any]] | None = None,
        max_iterations: int = MAX_ITERATIONS,
    ):
        self._adapter = adapter
        self._tools = tool_executor
        self._script_language = script_language
        self._knowledge_entries = knowledge_entries or []
        self._max_iterations = max_iterations
        self._validator = ReactValidator()
        self._failure_handler = ReactFailureHandler()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run(
        self,
        query: str,
        context: str = "",
        max_iter: int | None = None,
    ) -> dict[str, Any]:
        """Execute the full ReAct loop and return structured result."""
        max_iter = max_iter or self._max_iterations
        available_tools = self._tools.get_available_tools()
        tool_names = [t["name"] for t in available_tools]

        # Build knowledge context
        knowledge_context = format_knowledge_for_react(self._knowledge_entries)
        full_context = "\n\n".join(filter(None, [context, knowledge_context]))

        # Build system prompt via react_prompt module
        system_prompt = build_react_system_prompt(
            available_tools, self._script_language, full_context,
        )

        messages: list[dict[str, str]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ]
        tool_calls: list[dict] = []
        recent_actions: list[tuple[str, str]] = []  # for loop detection

        for i in range(max_iter):
            result = await self._adapter.chat(messages)
            content = self._extract_content(result)

            # Check for Final Answer
            if self._has_final_answer(content):
                answer = extract_final_answer(content)
                valid, reason = self._validator.validate_output(
                    {"answer": answer, "iterations": i + 1, "tool_calls": tool_calls},
                )
                if not valid:
                    logger.warning("react_validation_failed", reason=reason, iteration=i + 1)
                return {
                    "answer": answer,
                    "tool_calls": tool_calls,
                    "iterations": i + 1,
                    "knowledge_used": len(self._knowledge_entries),
                }

            # Parse action
            action, action_input = self._parse_action(content)
            if not action:
                # No action and no final answer — treat content as final answer
                return {
                    "answer": content,
                    "tool_calls": tool_calls,
                    "iterations": i + 1,
                    "knowledge_used": len(self._knowledge_entries),
                }

            # Validate action name
            if not self._validator.validate_action(action, tool_names):
                messages.append({"role": "assistant", "content": content})
                messages.append({
                    "role": "user",
                    "content": f"Observation: Unknown tool '{action}'. Available: {', '.join(tool_names)}",
                })
                continue

            # Loop detection
            action_sig = f"{action}:{json.dumps(action_input, sort_keys=True)}"
            if self._is_stuck(action_sig, recent_actions):
                logger.warning("react_loop_detected", action=action, iteration=i + 1)
                timeout_result = self._failure_handler.handle_loop_timeout(i + 1, tool_calls)
                return timeout_result
            recent_actions.append((action, action_sig))

            # Execute tool (with failure handling)
            observation = await self._execute_with_retry(action, action_input, i)
            tool_calls.append({
                "tool": action,
                "input": action_input,
                "output": observation,
                "iteration": i + 1,
            })

            messages.append({"role": "assistant", "content": content})
            messages.append({
                "role": "user",
                "content": f"Observation: {json.dumps(observation, ensure_ascii=False, default=str)}",
            })

        # Max iterations reached
        return self._failure_handler.handle_loop_timeout(max_iter, tool_calls)

    async def run_parallel(
        self,
        query: str,
        actions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Execute multiple tool actions in parallel."""
        return await execute_parallel_actions(self._tools, actions)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _execute_with_retry(
        self, action: str, action_input: dict[str, Any], iteration: int,
    ) -> dict[str, Any]:
        """Execute a tool call with failure handling and retry."""
        observation = await self._tools.execute(action, action_input)
        if not observation.get("success", True):
            failure_info = self._failure_handler.handle_tool_failure(
                action, observation.get("error", "unknown"), iteration,
            )
            if failure_info.get("retry") and iteration < self._max_iterations - 1:
                logger.info("react_retry", tool=action, iteration=iteration)
                observation = await self._tools.execute(action, action_input)
        return observation

    def _is_stuck(self, action_sig: str, recent: list[tuple[str, str]]) -> bool:
        """Detect if we're stuck in a loop by checking recent action signatures."""
        if len(recent) < _DUPLICATE_WINDOW:
            return False
        window = [sig for _, sig in recent[-_DUPLICATE_WINDOW:]]
        return window.count(action_sig) >= _DUPLICATE_WINDOW - 1

    @staticmethod
    def _extract_content(result: dict[str, Any]) -> str:
        choices = result.get("choices", [{}])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return ""

    @staticmethod
    def _has_final_answer(text: str) -> bool:
        return bool(re.search(r"Final Answer:", text, re.IGNORECASE))

    @staticmethod
    def _parse_action(text: str) -> tuple[str, dict[str, Any]]:
        action_match = re.search(r"Action:\s*(\w+)", text)
        input_match = re.search(r"Action Input:\s*(\{.*?\})", text, re.DOTALL)
        if not action_match:
            return "", {}
        action = action_match.group(1)
        params: dict[str, Any] = {}
        if input_match:
            try:
                params = json.loads(input_match.group(1))
            except json.JSONDecodeError:
                pass
        return action, params
