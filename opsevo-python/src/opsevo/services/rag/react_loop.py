"""ReactLoopController — ReAct reasoning loop (device-agnostic).

Integrates all sub-components: prompt building, knowledge retrieval,
output validation, failure handling, parallel execution, final answer extraction.

Supports dual-mode response handling:
  - Native tool_calls (OpenAI function calling) — preferred
  - Regex text parsing fallback — backward compatible

Requirements: 10.2, 1.8, 1.9, 3.1, 3.2, 3.3, 3.5, 3.7, 3.8, 3.11
"""

from __future__ import annotations

import json
import re
from typing import Any

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
        tool_registry: Any = None,
        tool_search: Any = None,
    ):
        self._adapter = adapter
        self._tools = tool_executor
        self._script_language = script_language
        self._knowledge_entries = knowledge_entries or []
        self._max_iterations = max_iterations
        self._tool_registry = tool_registry
        self._tool_search = tool_search
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
        """Execute the full ReAct loop and return structured result.

        Dual-mode: passes ``tools`` parameter to ``adapter.chat()`` for
        native function calling.  If the response contains ``tool_calls``,
        they are extracted directly (no regex).  Otherwise falls back to
        the existing regex-based ``Action:`` / ``Action Input:`` parsing.
        """
        max_iter = max_iter or self._max_iterations

        # Simple tool list for system prompt text (backward compat)
        available_tools = self._tools.get_available_tools()
        tool_names = [t["name"] for t in available_tools]

        # OpenAI-schema tool definitions for native tool_use (Req 3.1)
        openai_tool_schemas = self._tools.get_openai_tool_schemas()

        # Merge registry external tools into schemas (Req 5.2)
        if self._tool_registry is not None:
            try:
                registry_defs = self._tool_registry.get_all_tool_definitions()
                seen_names = {
                    s.get("function", {}).get("name", "") for s in openai_tool_schemas
                }
                for td in registry_defs:
                    fn = td.get("function", {})
                    name = fn.get("name", "")
                    # Skip local tools from registry (already have local executor tools)
                    if td.get("source") == "local":
                        continue
                    if name and name not in seen_names:
                        seen_names.add(name)
                        openai_tool_schemas.append(td)
                        tool_names.append(name)
            except Exception:
                logger.warning("react_registry_merge_failed",
                               reason="Failed to get tool definitions from tool_registry")

        # Apply ToolSearchMeta if available (Req 4.1, 4.4)
        if self._tool_search is not None and self._tool_search.should_use_search(openai_tool_schemas):
            openai_tool_schemas = self._tool_search.get_exposed_tools(openai_tool_schemas)
            tool_names = [
                s.get("function", {}).get("name", "") for s in openai_tool_schemas
            ]

        # Build knowledge context
        knowledge_context = format_knowledge_for_react(self._knowledge_entries)
        full_context = "\n\n".join(filter(None, [context, knowledge_context]))

        # Build system prompt via react_prompt module (unchanged — dual disclosure, Req 3.7)
        system_prompt = build_react_system_prompt(
            available_tools, self._script_language, full_context,
        )

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ]
        tool_calls_log: list[dict] = []
        recent_actions: list[tuple[str, str]] = []  # for loop detection

        for i in range(max_iter):
            # Pass tools= for native function calling (Req 3.1)
            result = await self._adapter.chat(messages, tools=openai_tool_schemas)

            # --- Native tool_calls branch (Req 3.2, 3.5) ---
            native_calls = self._extract_tool_calls(result)
            if native_calls:
                handled = await self._handle_native_tool_calls(
                    native_calls, result, messages, tool_calls_log,
                    tool_names, recent_actions, i,
                )
                if handled is not None:
                    # handled is a final-result dict (loop detected, etc.)
                    return handled
                continue

            # --- Fallback: text-based parsing (Req 3.3, 3.8) ---
            content = self._extract_content(result)

            # Check for Final Answer
            if self._has_final_answer(content):
                answer = extract_final_answer(content)
                valid, reason = self._validator.validate_output(
                    {"answer": answer, "iterations": i + 1, "tool_calls": tool_calls_log},
                )
                if not valid:
                    logger.warning("react_validation_failed", reason=reason, iteration=i + 1)
                return {
                    "answer": answer,
                    "tool_calls": tool_calls_log,
                    "iterations": i + 1,
                    "knowledge_used": len(self._knowledge_entries),
                }

            # Parse action via regex
            action, action_input = self._parse_action(content)
            if not action:
                # No action and no final answer — treat content as final answer
                return {
                    "answer": content,
                    "tool_calls": tool_calls_log,
                    "iterations": i + 1,
                    "knowledge_used": len(self._knowledge_entries),
                }

            # Log fallback usage (Req 3.8)
            logger.info(
                "react_regex_fallback",
                action=action,
                iteration=i + 1,
                reason="response has no tool_calls, using regex text parsing",
            )

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
                return self._failure_handler.handle_loop_timeout(i + 1, tool_calls_log)
            recent_actions.append((action, action_sig))

            # Execute tool (with failure handling)
            observation = await self._execute_with_retry(action, action_input, i)
            tool_calls_log.append({
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
        return self._failure_handler.handle_loop_timeout(max_iter, tool_calls_log)

    async def run_parallel(
        self,
        query: str,
        actions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Execute multiple tool actions in parallel."""
        return await execute_parallel_actions(self._tools, actions)

    # ------------------------------------------------------------------
    # Native tool_calls handling (Req 3.2, 3.5, 3.11)
    # ------------------------------------------------------------------

    async def _handle_native_tool_calls(
        self,
        native_calls: list[dict[str, Any]],
        raw_result: dict[str, Any],
        messages: list[dict[str, Any]],
        tool_calls_log: list[dict],
        tool_names: list[str],
        recent_actions: list[tuple[str, str]],
        iteration: int,
    ) -> dict[str, Any] | None:
        """Process native tool_calls from the AI response.

        Returns a final-result dict if the loop should terminate (e.g.
        loop detection), or ``None`` to continue the loop.
        """
        # Append the raw assistant message (with tool_calls) to history
        assistant_msg = self._build_assistant_tool_call_message(raw_result)
        messages.append(assistant_msg)

        # Parallel execution when multiple tool_calls (Req 3.11)
        if len(native_calls) > 1:
            return await self._execute_parallel_native_calls(
                native_calls, messages, tool_calls_log,
                tool_names, recent_actions, iteration,
            )

        # Single tool_call
        tc = native_calls[0]
        name = tc["name"]
        arguments = tc["arguments"]
        call_id = tc.get("id", "")

        # Loop detection
        action_sig = f"{name}:{json.dumps(arguments, sort_keys=True)}"
        if self._is_stuck(action_sig, recent_actions):
            logger.warning("react_loop_detected", action=name, iteration=iteration + 1)
            return self._failure_handler.handle_loop_timeout(iteration + 1, tool_calls_log)
        recent_actions.append((name, action_sig))

        # Execute
        observation = await self._execute_with_retry(name, arguments, iteration)
        tool_calls_log.append({
            "tool": name,
            "input": arguments,
            "output": observation,
            "iteration": iteration + 1,
        })

        # Append tool result message (role="tool", Req 3.5)
        messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "content": json.dumps(observation, ensure_ascii=False, default=str),
        })
        return None  # continue loop

    async def _execute_parallel_native_calls(
        self,
        native_calls: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tool_calls_log: list[dict],
        tool_names: list[str],
        recent_actions: list[tuple[str, str]],
        iteration: int,
    ) -> dict[str, Any] | None:
        """Execute multiple native tool_calls in parallel (Req 3.11)."""
        # Build action list for parallel execution
        actions = [{"tool": tc["name"], "input": tc.get("arguments", {})} for tc in native_calls]

        results = await execute_parallel_actions(self._tools, actions)

        for tc, obs in zip(native_calls, results):
            name = tc["name"]
            arguments = tc.get("arguments", {})
            call_id = tc.get("id", "")

            # Record in log
            tool_calls_log.append({
                "tool": name,
                "input": arguments,
                "output": obs,
                "iteration": iteration + 1,
            })

            # Loop detection bookkeeping
            action_sig = f"{name}:{json.dumps(arguments, sort_keys=True)}"
            recent_actions.append((name, action_sig))

            # Append tool result message
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": json.dumps(obs, ensure_ascii=False, default=str),
            })

        return None  # continue loop

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _execute_with_retry(
        self, action: str, action_input: dict[str, Any], iteration: int,
    ) -> dict[str, Any]:
        """Execute a tool call with failure handling, retry, and registry fallback.

        Handles search_tools meta-tool (Req 4.5).
        If the local tool executor returns "Unknown tool", routes to
        tool_registry.execute_tool() (Req 5.8).
        """
        # Handle search_tools meta-tool (Req 4.5)
        if action == "search_tools" and self._tool_search is not None:
            query = action_input.get("query", "")
            top_k = action_input.get("top_k", 5)
            try:
                results = await self._tool_search.search(query, top_k)
                return {
                    "success": True,
                    "data": results,
                }
            except Exception as exc:
                logger.warning("react_search_tools_failed", query=query, error=str(exc))
                return {"success": False, "error": str(exc)}

        observation = await self._tools.execute(action, action_input)

        # Route unknown local tools to registry (Req 5.8)
        if not observation.get("success", True) and "Unknown tool" in observation.get("error", ""):
            if self._tool_registry is not None:
                try:
                    result = await self._tool_registry.execute_tool(action, action_input)
                    # Normalize registry result to dict
                    if isinstance(result, dict):
                        return result
                    return {"success": True, "data": result}
                except Exception as exc:
                    logger.warning("react_registry_execute_failed", tool=action, error=str(exc))
                    return {"success": False, "error": str(exc)}

        if not observation.get("success", True):
            failure_info = self._failure_handler.handle_tool_failure(
                action, observation.get("error", "unknown"), iteration,
            )
            if failure_info.get("retry") and iteration < self._max_iterations - 1:
                logger.info("react_retry", tool=action, iteration=iteration)
                observation = await self._tools.execute(action, action_input)
                if not observation.get("success", True):
                    logger.warning("react_retry_also_failed", tool=action, iteration=iteration)
        return observation

    def _is_stuck(self, action_sig: str, recent: list[tuple[str, str]]) -> bool:
        """Detect if we're stuck in a loop by checking recent action signatures."""
        if len(recent) < _DUPLICATE_WINDOW:
            return False
        window = [sig for _, sig in recent[-_DUPLICATE_WINDOW:]]
        return window.count(action_sig) >= _DUPLICATE_WINDOW - 1

    @staticmethod
    def _extract_tool_calls(result: dict[str, Any]) -> list[dict[str, Any]]:
        """Extract native tool_calls from an OpenAI-style response.

        Returns a list of ``{"id": ..., "name": ..., "arguments": ...}``
        dicts, or an empty list when the response has no tool_calls.
        """
        choices = result.get("choices", [])
        if not choices:
            return []
        message = choices[0].get("message", {})
        raw_calls = message.get("tool_calls")
        if not raw_calls:
            return []

        parsed: list[dict[str, Any]] = []
        for tc in raw_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            if not name:
                continue
            # arguments may be a JSON string or already a dict
            args_raw = fn.get("arguments", "{}")
            if isinstance(args_raw, str):
                try:
                    arguments = json.loads(args_raw)
                except json.JSONDecodeError:
                    arguments = {}
            else:
                arguments = args_raw
            parsed.append({
                "id": tc.get("id", ""),
                "name": name,
                "arguments": arguments,
            })
        return parsed

    @staticmethod
    def _build_assistant_tool_call_message(result: dict[str, Any]) -> dict[str, Any]:
        """Build the assistant message dict to append to history when
        the response contains tool_calls.

        Preserves the original ``tool_calls`` structure so the provider
        can reconstruct the conversation correctly.
        """
        choices = result.get("choices", [{}])
        message = choices[0].get("message", {}) if choices else {}
        return {
            "role": "assistant",
            "content": message.get("content") or "",
            "tool_calls": message.get("tool_calls", []),
        }

    @staticmethod
    def _extract_content(result: dict[str, Any]) -> str:
        """Extract text content from a standard chat response."""
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
