"""UnifiedAgentService — single entry point for general / rag / agent chat.

Supports three modes:
  - general: direct LLM chat with optional session history
  - knowledge-enhanced (rag): knowledge retrieval + context injection + LLM
  - agent: tool calling via ReAct loop

Integrates: ChatSessionService, KnowledgeBase, ContextBuilderService,
ReactLoopController, RelevanceScorer.

Requirements: 11.1
"""

from __future__ import annotations

import time
import uuid
from typing import Any, AsyncIterator

from opsevo.data.datastore import DataStore
from opsevo.services.ai.adapter_pool import AdapterPool
from opsevo.services.ai.chat_session import ChatSessionService
from opsevo.services.ai.context_builder import ContextBuilderService
from opsevo.services.ai.relevance_scorer import RelevanceScorer
from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class UnifiedAgentService:
    """Unified AI agent supporting general, knowledge-enhanced, and agent modes."""

    def __init__(self, settings: Settings, datastore: DataStore, adapter_pool: AdapterPool):
        self._settings = settings
        self._ds = datastore
        self._pool = adapter_pool
        self._session_svc = ChatSessionService(datastore)
        self._context_builder = ContextBuilderService()
        self._scorer = RelevanceScorer()
        # Optional integrations (set after container wiring)
        self._knowledge_base: Any = None
        self._device_pool: Any = None
        self._tool_registry: Any = None
        self._tool_search: Any = None

    async def initialize(self) -> None:
        logger.info("unified_agent_initialized")

    # ------------------------------------------------------------------
    # Dependency injection setters (called after container init)
    # ------------------------------------------------------------------

    def set_knowledge_base(self, kb: Any) -> None:
        self._knowledge_base = kb

    def set_device_pool(self, pool: Any) -> None:
        self._device_pool = pool

    def set_tool_registry(self, registry: Any) -> None:
        self._tool_registry = registry

    def set_tool_search(self, ts: Any) -> None:
        self._tool_search = ts

    # ------------------------------------------------------------------
    # Non-streaming chat
    # ------------------------------------------------------------------

    async def chat(
        self,
        message: str,
        *,
        mode: str = "general",
        session_id: str = "",
        device_id: str = "",
        context: dict[str, Any] | None = None,
        rag_options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Non-streaming chat. Routes to the appropriate handler by mode."""
        start = time.monotonic()
        session = await self._get_or_create_session(session_id, device_id, mode)
        sid = session["id"]

        try:
            if mode == "knowledge-enhanced":
                result = await self._handle_knowledge_chat(message, sid, device_id, context, rag_options)
            elif mode == "agent":
                result = await self._handle_agent_chat(message, sid, device_id, context)
            else:
                result = await self._handle_general_chat(message, sid, context)

            duration_ms = int((time.monotonic() - start) * 1000)
            logger.debug("unified_chat_done", mode=mode, duration_ms=duration_ms)
            return result
        except Exception:
            logger.error("unified_chat_error", mode=mode, exc_info=True)
            raise

    # ------------------------------------------------------------------
    # Streaming chat
    # ------------------------------------------------------------------

    async def chat_stream(
        self,
        message: str,
        *,
        mode: str = "general",
        session_id: str = "",
        device_id: str = "",
        context: dict[str, Any] | None = None,
        rag_options: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming chat. Yields SSE-compatible chunks."""
        session = await self._get_or_create_session(session_id, device_id, mode)
        sid = session["id"]

        if mode == "knowledge-enhanced":
            async for chunk in self._stream_knowledge_chat(message, sid, device_id, context, rag_options):
                yield chunk
        elif mode == "agent":
            # Agent mode: run ReAct then stream the final answer
            result = await self._handle_agent_chat(message, sid, device_id, context)
            # Emit reasoning steps
            for r in result.get("reasoning", []):
                yield {"type": "reasoning", "reasoning": r}
            # Emit tool calls
            for tc in result.get("toolCalls", []):
                yield {"type": "tool_call", "toolCall": tc}
            # Emit content
            answer = result.get("message", "")
            yield {"type": "content", "content": answer}
            yield {"type": "done", "content": ""}
        else:
            async for chunk in self._stream_general_chat(message, sid, context):
                yield chunk

    # ------------------------------------------------------------------
    # General mode
    # ------------------------------------------------------------------

    async def _handle_general_chat(
        self, message: str, session_id: str, context: dict[str, Any] | None,
    ) -> dict[str, Any]:
        adapter = await self._pool.get_adapter()

        # Load conversation history
        history = await self._load_history(session_id)
        messages = self._build_messages(message, context, history)

        result = await adapter.chat(messages)
        content = self._extract_content(result)

        # Persist messages
        await self._save_exchange(session_id, message, content)

        return {
            "message": content,
            "sessionId": session_id,
            "mode": "general",
            "citations": [],
            "toolCalls": [],
        }

    async def _stream_general_chat(
        self, message: str, session_id: str, context: dict[str, Any] | None,
    ) -> AsyncIterator[dict[str, Any]]:
        adapter = await self._pool.get_adapter()
        history = await self._load_history(session_id)
        messages = self._build_messages(message, context, history)

        full_content = ""
        async for chunk in adapter.chat_stream(messages):
            choices = chunk.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                text = delta.get("content", "")
                if text:
                    full_content += text
                    yield {"type": "content", "content": text}

        await self._save_exchange(session_id, message, full_content)
        yield {"type": "done", "content": ""}

    # ------------------------------------------------------------------
    # Knowledge-enhanced (RAG) mode
    # ------------------------------------------------------------------

    async def _handle_knowledge_chat(
        self,
        message: str,
        session_id: str,
        device_id: str,
        context: dict[str, Any] | None,
        rag_options: dict[str, Any] | None,
    ) -> dict[str, Any]:
        reasoning: list[str] = []
        citations: list[dict[str, Any]] = []

        # 1. Retrieve knowledge
        reasoning.append("正在检索相关知识...")
        retrieval_start = time.monotonic()
        search_results = await self._retrieve_knowledge(message, rag_options)
        retrieval_ms = int((time.monotonic() - retrieval_start) * 1000)

        for r in search_results:
            citations.append({
                "entryId": r.get("id", ""),
                "title": r.get("title", ""),
                "content": str(r.get("content", ""))[:500],
                "score": r.get("score", 0),
                "type": "knowledge",
            })
        reasoning.append(f"检索到 {len(citations)} 条相关知识，耗时 {retrieval_ms}ms")

        # 2. Build enhanced messages with knowledge context
        adapter = await self._pool.get_adapter()
        history = await self._load_history(session_id)
        messages = self._build_enhanced_messages(message, context, history, citations)

        result = await adapter.chat(messages)
        content = self._extract_content(result)

        # 3. Persist
        await self._save_exchange(session_id, message, content)

        # 4. Confidence
        confidence = 0.5
        if citations:
            avg_score = sum(c["score"] for c in citations) / len(citations)
            confidence = max(confidence, avg_score)

        return {
            "message": content,
            "sessionId": session_id,
            "mode": "knowledge-enhanced",
            "citations": citations,
            "toolCalls": [],
            "reasoning": reasoning,
            "confidence": confidence,
            "ragContext": {
                "retrievalTime": retrieval_ms,
                "totalRetrievals": len(citations),
                "avgRelevanceScore": confidence,
            },
        }

    async def _stream_knowledge_chat(
        self,
        message: str,
        session_id: str,
        device_id: str,
        context: dict[str, Any] | None,
        rag_options: dict[str, Any] | None,
    ) -> AsyncIterator[dict[str, Any]]:
        yield {"type": "reasoning", "reasoning": "正在检索相关知识..."}

        search_results = await self._retrieve_knowledge(message, rag_options)
        citations: list[dict[str, Any]] = []
        for r in search_results:
            c = {
                "entryId": r.get("id", ""),
                "title": r.get("title", ""),
                "content": str(r.get("content", ""))[:500],
                "score": r.get("score", 0),
                "type": "knowledge",
            }
            citations.append(c)
            yield {"type": "citation", "citation": c}

        yield {"type": "reasoning", "reasoning": f"检索到 {len(citations)} 条相关知识"}

        adapter = await self._pool.get_adapter()
        history = await self._load_history(session_id)
        messages = self._build_enhanced_messages(message, context, history, citations)

        full_content = ""
        async for chunk in adapter.chat_stream(messages):
            choices = chunk.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                text = delta.get("content", "")
                if text:
                    full_content += text
                    yield {"type": "content", "content": text}

        await self._save_exchange(session_id, message, full_content)
        yield {"type": "done", "content": ""}

    # ------------------------------------------------------------------
    # Agent mode (ReAct loop)
    # ------------------------------------------------------------------

    async def _handle_agent_chat(
        self,
        message: str,
        session_id: str,
        device_id: str,
        context: dict[str, Any] | None,
    ) -> dict[str, Any]:
        reasoning: list[str] = []
        tool_calls_out: list[dict[str, Any]] = []

        # Get device driver if available
        driver = None
        if device_id and self._device_pool:
            try:
                driver = await self._device_pool.get_driver(device_id)
            except Exception as exc:
                logger.warning("agent_no_driver", device_id=device_id, error=str(exc))

        if not driver:
            reasoning.append("无可用设备驱动，回退到标准模式")
            return await self._handle_general_chat(message, session_id, context)

        # Retrieve knowledge for ReAct context
        knowledge_entries: list[dict[str, Any]] = []
        if self._knowledge_base:
            try:
                knowledge_entries = await self._knowledge_base.search(message, top_k=5)
            except Exception:
                logger.warning("agent_knowledge_retrieval_failed", exc_info=True)

        # Build device context
        device_context = ""
        try:
            ctx = await self._context_builder.build_context(driver)
            device_context = f"Device: {ctx.get('vendor', '')} {ctx.get('model', '')}"
        except Exception:
            pass

        # Create ReAct loop
        from opsevo.services.rag.react_loop import ReactLoopController
        from opsevo.services.rag.react_tools import ReactToolExecutor

        adapter = await self._pool.get_adapter()
        executor = ReactToolExecutor(driver)
        manifest = driver.get_capability_manifest()
        loop = ReactLoopController(
            adapter,
            executor,
            script_language=manifest.script_language,
            knowledge_entries=knowledge_entries,
            tool_registry=self._tool_registry,
            tool_search=self._tool_search,
        )

        reasoning.append("正在执行 ReAct 工具调用循环...")
        react_result = await loop.run(message, context=device_context)

        # Extract tool calls
        for tc in react_result.get("tool_calls", []):
            tool_calls_out.append({
                "id": f"tool_{len(tool_calls_out)}",
                "tool": tc.get("tool", ""),
                "input": tc.get("input", {}),
                "output": tc.get("output"),
                "iteration": tc.get("iteration", 0),
            })

        reasoning.append(f"ReAct 循环完成，迭代 {react_result.get('iterations', 0)} 次")
        if react_result.get("knowledge_used", 0) > 0:
            reasoning.append(f"使用了 {react_result['knowledge_used']} 条知识条目")

        answer = react_result.get("answer", "")
        await self._save_exchange(session_id, message, answer)

        return {
            "message": answer,
            "sessionId": session_id,
            "mode": "agent",
            "citations": [],
            "toolCalls": tool_calls_out,
            "reasoning": reasoning,
            "confidence": 0.4 if react_result.get("timeout") else 0.8,
        }

    # ------------------------------------------------------------------
    # Session management helpers
    # ------------------------------------------------------------------

    async def _get_or_create_session(
        self, session_id: str, device_id: str = "", mode: str = "general",
    ) -> dict[str, Any]:
        if session_id:
            existing = await self._session_svc.get_session(session_id)
            if existing:
                return existing
        return await self._session_svc.create_session(device_id=device_id, mode=mode)

    async def _load_history(self, session_id: str, limit: int = 20) -> list[dict[str, str]]:
        """Load recent conversation history for context."""
        try:
            msgs = await self._session_svc.get_messages(session_id, limit=limit)
            return [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in msgs]
        except Exception:
            return []

    async def _save_exchange(self, session_id: str, user_msg: str, assistant_msg: str) -> None:
        """Persist user + assistant messages to the session."""
        try:
            await self._session_svc.add_message(session_id, "user", user_msg)
            await self._session_svc.add_message(session_id, "assistant", assistant_msg)
        except Exception:
            logger.warning("save_exchange_failed", session_id=session_id, exc_info=True)

    # ------------------------------------------------------------------
    # Knowledge retrieval
    # ------------------------------------------------------------------

    async def _retrieve_knowledge(
        self, query: str, rag_options: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if not self._knowledge_base:
            return []
        opts = rag_options or {}
        top_k = opts.get("topK", 5)
        threshold = opts.get("threshold", 0.3)
        try:
            results = await self._knowledge_base.search(query, top_k=top_k, threshold=threshold)
            return results
        except Exception:
            logger.warning("knowledge_retrieval_failed", exc_info=True)
            return []

    # ------------------------------------------------------------------
    # Message building
    # ------------------------------------------------------------------

    @staticmethod
    def _build_messages(
        message: str,
        context: dict[str, Any] | None,
        history: list[dict[str, str]],
    ) -> list[dict[str, str]]:
        msgs: list[dict[str, str]] = []
        if context and context.get("system_prompt"):
            msgs.append({"role": "system", "content": context["system_prompt"]})
        # Append conversation history
        msgs.extend(history)
        msgs.append({"role": "user", "content": message})
        return msgs

    @staticmethod
    def _build_enhanced_messages(
        message: str,
        context: dict[str, Any] | None,
        history: list[dict[str, str]],
        citations: list[dict[str, Any]],
    ) -> list[dict[str, str]]:
        """Build messages with knowledge context injected into system prompt."""
        knowledge_block = ""
        if citations:
            parts = ["以下是与用户问题相关的知识库内容，请参考回答：\n"]
            for i, c in enumerate(citations, 1):
                title = c.get("title", "")
                content = c.get("content", "")
                score = c.get("score", 0)
                parts.append(f"[{i}] {title} (相关度: {score:.2f})\n{content}\n")
            knowledge_block = "\n".join(parts)

        system_parts = []
        if context and context.get("system_prompt"):
            system_parts.append(context["system_prompt"])
        if knowledge_block:
            system_parts.append(knowledge_block)

        msgs: list[dict[str, str]] = []
        if system_parts:
            msgs.append({"role": "system", "content": "\n\n".join(system_parts)})
        msgs.extend(history)
        msgs.append({"role": "user", "content": message})
        return msgs

    @staticmethod
    def _extract_content(result: dict[str, Any]) -> str:
        choices = result.get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return ""
