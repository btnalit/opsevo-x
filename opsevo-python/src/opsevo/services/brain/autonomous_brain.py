"""
AutonomousBrainService — OODA 循环（Observe-Orient-Decide-Act-Learn）

- tick 驱动执行，APScheduler 定时触发
- 会话轮换（每 20 次 tick）
- token 预算硬阻断
- 感知源注册与上下文收集
- 情景记忆与衰减
- EventPriorityQueue: 堆实现的事件优先级队列
- 背压控制: 队列满时丢弃最低优先级事件
- Cooldown: 异常后冷却恢复
- Heartbeat: 定期发布心跳事件
- Episodic memory 持久化到 DB
"""

from __future__ import annotations

import asyncio
import heapq
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# 优先级映射 (数值越小优先级越高)
# ---------------------------------------------------------------------------
PRIORITY_ORDER: dict[str, int] = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
    "info": 4,
}


# ---------------------------------------------------------------------------
# EventPriorityQueue — 最小堆优先级队列
# ---------------------------------------------------------------------------

@dataclass(order=True)
class _PQEntry:
    """堆条目: 按 (priority_num, timestamp) 排序。"""
    priority_num: int
    timestamp: float
    event: dict[str, Any] = field(compare=False)


class EventPriorityQueue:
    """最小堆优先级队列，按 priority 数值排序，同优先级按时间戳 FIFO。"""

    def __init__(self) -> None:
        self._heap: list[_PQEntry] = []

    @property
    def size(self) -> int:
        return len(self._heap)

    def is_empty(self) -> bool:
        return len(self._heap) == 0

    def enqueue(self, event: dict[str, Any]) -> None:
        priority_str = event.get("priority", "medium")
        entry = _PQEntry(
            priority_num=PRIORITY_ORDER.get(priority_str, 2),
            timestamp=event.get("timestamp", time.time()),
            event=event,
        )
        heapq.heappush(self._heap, entry)

    def dequeue(self) -> dict[str, Any] | None:
        if not self._heap:
            return None
        return heapq.heappop(self._heap).event

    def peek(self) -> dict[str, Any] | None:
        return self._heap[0].event if self._heap else None

    def drop_lowest_priority(self) -> dict[str, Any] | None:
        """丢弃最低优先级事件 (critical 永不丢弃)。"""
        if not self._heap:
            return None
        worst_idx = -1
        worst_prio = -1
        for i, entry in enumerate(self._heap):
            if entry.event.get("priority") != "critical" and entry.priority_num > worst_prio:
                worst_prio = entry.priority_num
                worst_idx = i
        if worst_idx == -1:
            return None
        dropped = self._heap[worst_idx]
        self._heap[worst_idx] = self._heap[-1]
        self._heap.pop()
        if self._heap and worst_idx < len(self._heap):
            heapq.heapify(self._heap)
        return dropped.event

    def drain(self) -> list[dict[str, Any]]:
        result = []
        while self._heap:
            result.append(heapq.heappop(self._heap).event)
        return result

    def clear(self) -> None:
        self._heap.clear()


class OODAPhase(str, Enum):
    OBSERVE = "observe"
    ORIENT = "orient"
    DECIDE = "decide"
    ACT = "act"
    LEARN = "learn"
    ERROR = "error"


@dataclass
class EpisodicMemory:
    content: str
    context: str
    source: str  # "observation" | "action" | "learning" | "external"
    timestamp: float = field(default_factory=time.time)
    relevance: float = 1.0
    match_key: str = ""


@dataclass
class BrainTickContext:
    tick_id: str = ""
    trigger: str = "schedule"
    active_alerts: list[dict] = field(default_factory=list)
    recent_metrics: dict[str, Any] = field(default_factory=dict)
    health_summary: dict[str, Any] = field(default_factory=dict)
    predictions: list[dict] = field(default_factory=list)
    patterns: list[dict] = field(default_factory=list)
    pending_decisions: list[dict] = field(default_factory=list)
    device_id: str | None = None
    device_inventory: dict[str, Any] = field(default_factory=dict)


@dataclass
class BrainConfig:
    tick_interval_s: float = 60.0
    session_max_ticks: int = 20
    token_budget: int = 100_000
    memory_max_episodes: int = 200
    memory_decay_rate: float = 0.05
    context_timeout_s: float = 10.0
    max_concurrent_collections: int = 5
    # 背压控制
    high_water_mark: int = 100
    low_water_mark: int = 50
    # Cooldown
    cooldown_s: float = 5.0
    # Heartbeat
    heartbeat_interval_s: float = 30.0
    # Tick 超时
    tick_timeout_s: float = 120.0


class AutonomousBrainService:
    """OODA 循环自主大脑服务。"""

    # Progressive Disclosure: tools available per OODA phase
    OBSERVE_TOOLS: frozenset[str] = frozenset({
        "query_device", "search_knowledge", "analyze_alert",
        "list_skills", "list_mcp_servers", "collect_metrics",
        "list_devices", "distill_knowledge", "learn_patterns",
    })
    ACT_TOOLS: frozenset[str] = frozenset({
        "query_device", "search_knowledge", "analyze_alert",
        "list_skills", "list_mcp_servers", "collect_metrics",
        "list_devices", "distill_knowledge", "learn_patterns",
        "execute_command", "update_config", "create_remediation",
        "invoke_skill", "send_notification", "schedule_task",
        "create_skill", "configure_mcp_server",
        "evolve_alert_rule", "auto_heal",
    })

    def __init__(
        self,
        config: BrainConfig | None = None,
        event_bus: Any = None,
        datastore: Any = None,
        brain_tools: Any = None,
        adapter_pool: Any = None,
        perception_cache: Any = None,
        tool_registry: Any = None,
        tool_search: Any = None,
        knowledge_distiller: Any = None,
    ) -> None:
        self._config = config or BrainConfig()
        self._event_bus = event_bus
        self._datastore = datastore
        self._brain_tools = brain_tools
        self._adapter_pool = adapter_pool
        self._perception_cache = perception_cache
        self._tool_registry = tool_registry
        self._tool_search = tool_search
        self._knowledge_distiller = knowledge_distiller

        self._running = False
        self._tick_task: asyncio.Task[None] | None = None
        self._tick_count = 0
        self._session_id = str(uuid.uuid4())
        self._total_tokens_used = 0
        self._episodes: list[EpisodicMemory] = []
        self._notes: list[str] = []
        self._thinking_listeners: list[Callable[..., Any]] = []
        self._skill_factory: Any = None
        self._tick_lock = asyncio.Lock()

        # 事件优先级队列
        self._queue_lock = asyncio.Lock()
        self._high_priority_queue = EventPriorityQueue()
        self._event_queue = EventPriorityQueue()

        # 状态机: running / processing_tick / cooldown / backpressure
        self._state: str = "initializing"

        # 背压统计
        self._dropped_total = 0
        self._dropped_by_label: dict[str, int] = {}

        # Heartbeat / Cooldown 任务
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._cooldown_task: asyncio.Task[None] | None = None
        self._last_tick_duration_ms: float = 0

        logger.info("AutonomousBrainService initialized", config=self._config)

    def set_skill_factory(self, sf: Any) -> None:
        self._skill_factory = sf

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._state = "running"
        self._session_id = str(uuid.uuid4())
        self._tick_count = 0
        self._total_tokens_used = 0
        self._register_perception_sources()
        # 从 DB 恢复 episodic memory
        await self._load_memory()
        # 订阅事件总线
        if self._event_bus:
            self._event_bus.on("alert", self._on_event)
            self._event_bus.on("metric_anomaly", self._on_event)
            self._event_bus.on("topology_change", self._on_event)
        # 启动心跳
        self._start_heartbeat()
        self._tick_task = asyncio.create_task(self._tick_loop())
        logger.info("AutonomousBrainService started", session_id=self._session_id)

    async def stop(self) -> None:
        self._running = False
        self._state = "stopped"
        # 停止心跳
        self._stop_heartbeat()
        # 取消 cooldown
        if self._cooldown_task and not self._cooldown_task.done():
            self._cooldown_task.cancel()
            self._cooldown_task = None
        # 取消 tick loop
        if self._tick_task and not self._tick_task.done():
            self._tick_task.cancel()
            self._tick_task = None
        # 取消事件订阅
        if self._event_bus:
            self._event_bus.off("alert", self._on_event)
            self._event_bus.off("metric_anomaly", self._on_event)
            self._event_bus.off("topology_change", self._on_event)
        # 持久化 episodic memory 到 DB
        await self._persist_memory()
        logger.info("AutonomousBrainService stopped")

    async def trigger_tick(self, reason: str = "manual", payload: Any = None) -> None:
        if not self._running:
            return
        await self._tick(reason)

    # ------------------------------------------------------------------
    # main loop
    # ------------------------------------------------------------------
    async def _tick_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._config.tick_interval_s)
                if self._running:
                    await self._tick("schedule")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Brain tick loop error")

    async def _tick(self, trigger: str) -> None:
        async with self._tick_lock:
            await self._tick_inner(trigger)

    async def _tick_inner(self, trigger: str) -> None:
        tick_id = str(uuid.uuid4())[:8]
        self._tick_count += 1

        # session rotation
        if self._tick_count > self._config.session_max_ticks:
            self._rotate_session()

        # token budget check
        if self._total_tokens_used >= self._config.token_budget:
            logger.warning("Token budget exhausted, skipping tick", used=self._total_tokens_used)
            return

        # Reset per-tick rate limiters on brain_tools
        if self._brain_tools is not None and hasattr(self._brain_tools, "reset_tick_counters"):
            self._brain_tools.reset_tick_counters()

        max_react_steps = 5

        try:
            # OODA phases
            self._emit_thinking(OODAPhase.OBSERVE, "Gathering context...")
            ctx = await self._gather_context(tick_id, trigger)

            self._emit_thinking(OODAPhase.ORIENT, "Analyzing situation...")
            prompt = self._build_prompt(ctx, ooda_phase=OODAPhase.DECIDE)

            # Build tool schemas once for the whole ReAct loop
            tool_schemas = self._build_tool_schemas()

            # Initialise message history for multi-turn ReAct loop
            messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]

            for step in range(max_react_steps):
                self._emit_thinking(OODAPhase.DECIDE, f"Making decisions (step {step + 1})...")
                response = await self._call_ai_with_messages(messages, tool_schemas, ctx)

                # Extract tool_calls from the response
                tool_calls = self._extract_tool_calls(response)

                if not tool_calls:
                    # No more tool calls — LLM is done reasoning
                    self._emit_thinking(OODAPhase.ACT, "Executing final actions...")
                    await self._execute_actions(response, ctx)
                    break

                # Execute tools and collect results
                self._emit_thinking(OODAPhase.ACT, f"Executing {len(tool_calls)} tool(s)...")
                tool_results = await self._handle_tool_calls_with_results(tool_calls, ctx)

                # Append assistant message (with tool_calls) + tool results to history
                assistant_msg = self._extract_assistant_message(response)
                messages.append(assistant_msg)
                for tr in tool_results:
                    messages.append(tr)
            else:
                logger.info("ReAct loop reached max steps", tick_id=tick_id, steps=max_react_steps)

            self._emit_thinking(OODAPhase.LEARN, "Recording learnings...")
            self._record_learning(response, ctx)

            self._decay_memory()

            # Auto-distill knowledge every 5 ticks
            if self._knowledge_distiller is not None and self._tick_count % 5 == 0:
                try:
                    distilled = await self._knowledge_distiller.distill()
                    if distilled:
                        self._add_episode(
                            f"Auto-distilled {len(distilled)} knowledge entries",
                            f"tick={tick_id}",
                            "learning",
                        )
                        logger.info("brain_auto_distill", count=len(distilled), tick=tick_id)
                except Exception as exc:
                    logger.warning("brain_auto_distill_failed", error=str(exc))

            # Persist episodic memory every tick (crash-safe)
            await self._persist_memory()
        except Exception as exc:
            self._emit_thinking(OODAPhase.ERROR, f"Tick error: {exc}")
            logger.exception("Brain tick failed", tick_id=tick_id)

    # ------------------------------------------------------------------
    # context gathering
    # ------------------------------------------------------------------
    async def _gather_context(self, tick_id: str, trigger: str) -> BrainTickContext:
        ctx = BrainTickContext(tick_id=tick_id, trigger=trigger)

        async def _safe(coro: Awaitable[Any], label: str) -> Any:
            try:
                return await asyncio.wait_for(coro, timeout=self._config.context_timeout_s)
            except Exception:
                logger.warning(f"Context gather failed: {label}")
                return None

        if self._perception_cache:
            cache = self._perception_cache
            results = await asyncio.gather(
                _safe(cache.get_active_alerts(), "alerts"),
                _safe(cache.get_recent_metrics(), "metrics"),
                _safe(cache.get_health_summary(), "health"),
                _safe(cache.get_predictions(), "predictions"),
                _safe(cache.get_patterns(), "patterns"),
                return_exceptions=True,
            )
            ctx.active_alerts = results[0] if isinstance(results[0], list) else []
            ctx.recent_metrics = results[1] if isinstance(results[1], dict) else {}
            ctx.health_summary = results[2] if isinstance(results[2], dict) else {}
            ctx.predictions = results[3] if isinstance(results[3], list) else []
            ctx.patterns = results[4] if isinstance(results[4], list) else []

            # 获取设备清单
            try:
                inv = await asyncio.wait_for(
                    cache.get_device_inventory(), timeout=self._config.context_timeout_s,
                )
                if isinstance(inv, dict):
                    ctx.device_inventory = inv
            except Exception:
                logger.warning("Context gather failed: device_inventory")

        # consume notes
        current_notes = list(self._notes)
        self._notes.clear()

        return ctx

    # ------------------------------------------------------------------
    # AI interaction
    # ------------------------------------------------------------------
    def _build_prompt(self, ctx: BrainTickContext, *, ooda_phase: OODAPhase = OODAPhase.DECIDE) -> str:
        parts = [
            "You are the autonomous brain of an AIOps system.",
            f"Tick trigger: {ctx.trigger}",
        ]
        if ctx.active_alerts:
            parts.append(f"Active alerts ({len(ctx.active_alerts)}): {self._compress_alerts(ctx.active_alerts)}")
        if ctx.predictions:
            parts.append(f"Predictions: {self._compress_predictions(ctx.predictions)}")
        if ctx.patterns:
            parts.append(f"Patterns: {self._compress_patterns(ctx.patterns)}")
        if ctx.device_inventory:
            summary = ctx.device_inventory.get("summary", {})
            if summary:
                parts.append(
                    f"Device inventory: {summary.get('total', 0)} total, "
                    f"{summary.get('online', 0)} online, "
                    f"{summary.get('offline', 0)} offline, "
                    f"avg health {summary.get('avg_health_score', 0)}"
                )
        if self._episodes:
            recent = self._episodes[-5:]
            parts.append("Recent memory: " + "; ".join(e.content[:100] for e in recent))

        # Tool injection with Progressive Disclosure
        tools_section = self._format_tools_for_prompt(ooda_phase)
        if tools_section:
            parts.append(tools_section)

        parts.append(
            "Decide what actions to take. Respond in JSON with 'actions' array "
            "(each action has 'tool' and 'params') and 'reasoning' string."
        )
        return "\n\n".join(parts)

    def _get_tools_for_phase(self, ooda_phase: OODAPhase) -> list[dict[str, Any]]:
        """Return tool definitions filtered by OODA phase (Progressive Disclosure).

        Merges brain_tools with external tools from tool_registry.
        Deduplicates by name — brain_tools (local) take priority.
        Requirements: 5.1, 5.2
        """
        if ooda_phase in (OODAPhase.OBSERVE, OODAPhase.ORIENT):
            allowed = self.OBSERVE_TOOLS
        else:
            allowed = self.ACT_TOOLS

        # Collect local brain tools
        local_tools: list[dict[str, Any]] = []
        if self._brain_tools is not None:
            try:
                all_brain = self._brain_tools.get_tool_definitions()
            except Exception:
                logger.warning("Failed to get tool definitions from brain_tools")
                all_brain = []
            local_tools = [t for t in all_brain if t.get("name") in allowed]

        # Merge external tools from registry (dedup by name, local priority)
        seen_names = {t.get("name") for t in local_tools}
        if self._tool_registry is not None:
            try:
                registry_defs = self._tool_registry.get_all_tool_definitions()
            except Exception:
                logger.warning("Failed to get tool definitions from tool_registry")
                registry_defs = []
            for td in registry_defs:
                fn = td.get("function", {})
                name = fn.get("name", "")
                source = td.get("source", "external")
                # Skip local tools from registry (already have brain_tools)
                if source == "local":
                    continue
                if name and name not in seen_names:
                    seen_names.add(name)
                    # Convert registry format to brain-tools-like dict for prompt
                    local_tools.append({
                        "name": name,
                        "description": fn.get("description", ""),
                        "parameters": fn.get("parameters", {}),
                        "source": source,
                    })

        return local_tools

    def _format_tools_for_prompt(self, ooda_phase: OODAPhase) -> str:
        """Format filtered tool definitions into prompt text."""
        tools = self._get_tools_for_phase(ooda_phase)
        if not tools:
            return ""

        lines = ["Available tools:"]
        for tool in tools:
            name = tool.get("name", "")
            desc = tool.get("description", "")
            params = tool.get("parameters", {})
            negative = tool.get("negative_constraint", "")
            examples = tool.get("input_examples", [])

            lines.append(f"- {name}: {desc}")
            if params:
                params_str = ", ".join(
                    f"{k}: {v}" for k, v in params.items()
                )
                lines.append(f"  Parameters: {params_str}")
            if negative:
                lines.append(f"  ⚠️ Not for: {negative}")
            for ex in examples[:2]:
                lines.append(f"  Example: {json.dumps(ex, ensure_ascii=False)}")

        return "\n".join(lines)

    async def _call_ai(self, prompt: str, ctx: BrainTickContext) -> dict[str, Any]:
        """Legacy single-shot AI call (kept for backward compat)."""
        tool_schemas = self._build_tool_schemas()
        messages = [{"role": "user", "content": prompt}]
        result = await self._call_ai_with_messages(messages, tool_schemas, ctx)
        # Legacy: also handle tool_calls inline (single step)
        tool_calls = self._extract_tool_calls(result)
        if tool_calls:
            await self._handle_tool_calls(tool_calls, ctx)
        return result

    def _build_tool_schemas(self) -> list[dict] | None:
        """Build merged tool schemas from brain_tools + registry."""
        brain_schemas: list[dict] = []
        if self._brain_tools is not None:
            try:
                brain_schemas = self._brain_tools.get_openai_tool_schemas()
            except Exception:
                logger.warning("Failed to get OpenAI tool schemas from brain_tools")

        registry_schemas: list[dict] = []
        if self._tool_registry is not None:
            try:
                registry_defs = self._tool_registry.get_all_tool_definitions()
                registry_schemas = [
                    td for td in registry_defs if td.get("source") != "local"
                ]
            except Exception:
                logger.warning("Failed to get tool definitions from tool_registry")

        merged = list(brain_schemas)
        seen_names = {s.get("function", {}).get("name", "") for s in merged}
        for rs in registry_schemas:
            name = rs.get("function", {}).get("name", "")
            if name and name not in seen_names:
                seen_names.add(name)
                merged.append(rs)

        if not merged:
            return None

        if self._tool_search is not None and self._tool_search.should_use_search(merged):
            return self._tool_search.get_exposed_tools(merged)
        return merged

    async def _call_ai_with_messages(
        self,
        messages: list[dict[str, Any]],
        tool_schemas: list[dict] | None,
        ctx: BrainTickContext,
    ) -> dict[str, Any]:
        """Call LLM with full message history (ReAct multi-turn)."""
        if self._adapter_pool is None:
            return {"actions": [], "reasoning": "No AI adapter available"}
        try:
            adapter = await self._adapter_pool.get_adapter()
            result = await adapter.chat(messages=messages, tools=tool_schemas)
            self._track_token_usage(result)
            return result
        except Exception:
            logger.exception("Brain AI call failed")
            return {"actions": [], "reasoning": "AI call failed"}

    @staticmethod
    def _extract_assistant_message(result: dict[str, Any]) -> dict[str, Any]:
        """Extract the assistant message dict from an AI response for message history."""
        choices = result.get("choices", [])
        if choices and isinstance(choices[0], dict):
            msg = choices[0].get("message", {})
            if msg:
                return msg
        # Fallback: construct from top-level fields
        content = result.get("content", result.get("reasoning", ""))
        msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
        tc = result.get("tool_calls")
        if tc:
            msg["tool_calls"] = tc
        return msg

    async def _handle_tool_calls_with_results(
        self, tool_calls: list[dict[str, Any]], ctx: BrainTickContext,
    ) -> list[dict[str, Any]]:
        """Execute tool_calls and return tool-role messages for the message history."""
        tool_messages: list[dict[str, Any]] = []
        for tc in tool_calls[:10]:
            func = tc.get("function", tc)
            tool_name = func.get("name", "")
            tool_call_id = tc.get("id", tool_name)
            raw_args = func.get("arguments", "{}")
            if isinstance(raw_args, str):
                try:
                    params = json.loads(raw_args)
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Failed to parse tool_call arguments", tool=tool_name)
                    tool_messages.append({
                        "role": "tool", "tool_call_id": tool_call_id,
                        "content": json.dumps({"error": "Failed to parse arguments"}),
                    })
                    continue
            else:
                params = raw_args if isinstance(raw_args, dict) else {}

            if not tool_name:
                continue

            # search_tools meta-tool
            if tool_name == "search_tools":
                if self._tool_search is not None:
                    query = params.get("query", "")
                    top_k = params.get("top_k", 5)
                    try:
                        results = await self._tool_search.search(query, top_k)
                        self._add_episode(f"Tool search: {query}", f"{len(results)} results", "action")
                        tool_messages.append({
                            "role": "tool", "tool_call_id": tool_call_id,
                            "content": json.dumps({"results": len(results)}),
                        })
                    except Exception:
                        tool_messages.append({
                            "role": "tool", "tool_call_id": tool_call_id,
                            "content": json.dumps({"error": "search failed"}),
                        })
                continue

            result_str = ""
            try:
                if self._brain_tools is not None:
                    try:
                        res = await self._brain_tools.execute(tool_name, params, device_id=ctx.device_id)
                        result_str = str(res)[:2000] if res else "OK"
                        self._add_episode(f"Tool call: {tool_name}", str(params)[:200], "action")
                    except ValueError:
                        res = None
                    else:
                        tool_messages.append({
                            "role": "tool", "tool_call_id": tool_call_id,
                            "content": result_str,
                        })
                        continue

                if self._tool_registry is not None:
                    res = await self._tool_registry.execute_tool(tool_name, params)
                    result_str = str(res)[:2000] if res else "OK"
                    self._add_episode(f"Tool call (registry): {tool_name}", str(res)[:200], "action")
                else:
                    result_str = f"Tool not found: {tool_name}"
            except Exception as exc:
                result_str = f"Tool execution failed: {exc}"
                logger.warning(f"Brain tool_call execution failed: {tool_name}")

            tool_messages.append({
                "role": "tool", "tool_call_id": tool_call_id,
                "content": result_str,
            })

        return tool_messages

    @staticmethod
    def _extract_tool_calls(result: dict[str, Any]) -> list[dict[str, Any]]:
        """Extract tool_calls from AI response (OpenAI format)."""
        # Direct tool_calls at top level
        if "tool_calls" in result:
            return result["tool_calls"]
        # Nested in choices[0].message.tool_calls (OpenAI response format)
        choices = result.get("choices", [])
        if choices:
            message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
            tc = message.get("tool_calls")
            if tc:
                return tc
        return []

    async def _handle_tool_calls(
        self, tool_calls: list[dict[str, Any]], ctx: BrainTickContext
    ) -> None:
        """Execute tool_calls extracted from AI native tool_use response.

        Routes to brain_tools first; falls back to tool_registry for
        external/skill tools.
        """
        for tc in tool_calls[:10]:  # cap at 10
            func = tc.get("function", tc)
            tool_name = func.get("name", "")
            raw_args = func.get("arguments", "{}")
            if isinstance(raw_args, str):
                try:
                    params = json.loads(raw_args)
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Failed to parse tool_call arguments", tool=tool_name)
                    continue
            else:
                params = raw_args if isinstance(raw_args, dict) else {}

            if not tool_name:
                continue

            # Handle search_tools meta-tool (Req 4.5)
            if tool_name == "search_tools":
                if self._tool_search is not None:
                    query = params.get("query", "")
                    top_k = params.get("top_k", 5)
                    try:
                        results = await self._tool_search.search(query, top_k)
                        self._add_episode(
                            f"Tool search: {query}",
                            f"{len(results)} results",
                            "action",
                        )
                    except Exception:
                        logger.warning("search_tools execution failed", query=query)
                continue

            try:
                # Try brain_tools first
                if self._brain_tools is not None:
                    try:
                        await self._brain_tools.execute(tool_name, params, device_id=ctx.device_id)
                        self._add_episode(f"Tool call: {tool_name}", str(params)[:200], "action")
                        continue
                    except ValueError:
                        # Unknown brain tool — fall through to registry
                        pass

                # Fallback to tool_registry for external/skill tools
                if self._tool_registry is not None:
                    result = await self._tool_registry.execute_tool(tool_name, params)
                    self._add_episode(f"Tool call (registry): {tool_name}", str(result)[:200], "action")
                else:
                    logger.warning(f"Brain tool_call not found: {tool_name}")
            except Exception:
                logger.warning(f"Brain tool_call execution failed: {tool_name}")

    async def _execute_actions(self, response: dict, ctx: BrainTickContext) -> None:
        actions = response.get("actions", [])
        if not actions or not self._brain_tools:
            return
        for action in actions[:10]:  # cap at 10 actions per tick
            tool_name = action.get("tool", "")
            params = action.get("params", {})
            try:
                await self._brain_tools.execute(tool_name, params, device_id=ctx.device_id)
                self._add_episode(f"Executed {tool_name}", str(params)[:200], "action")
            except Exception:
                logger.warning(f"Brain action failed: {tool_name}")

    # ------------------------------------------------------------------
    # memory
    # ------------------------------------------------------------------
    def push_note(self, note: str, source: str = "internal") -> None:
        self._notes.append(note)

    def _add_episode(self, content: str, context: str, source: str) -> None:
        ep = EpisodicMemory(content=content, context=context, source=source)
        self._episodes.append(ep)
        if len(self._episodes) > self._config.memory_max_episodes:
            self._episodes = sorted(self._episodes, key=lambda e: e.relevance, reverse=True)
            self._episodes = self._episodes[: self._config.memory_max_episodes]

    def _decay_memory(self) -> None:
        for ep in self._episodes:
            ep.relevance *= 1.0 - self._config.memory_decay_rate
        self._episodes = [e for e in self._episodes if e.relevance > 0.01]

    def _record_learning(self, response: dict, ctx: BrainTickContext) -> None:
        reasoning = response.get("reasoning", "")
        if reasoning:
            self._add_episode(reasoning[:300], f"tick={ctx.tick_id}", "learning")
        # Feed experience to KnowledgeDistiller for autonomous knowledge extraction
        if self._knowledge_distiller is not None:
            actions = response.get("actions", [])
            action_summary = ", ".join(a.get("tool", "") for a in actions[:5]) if actions else "no actions"
            outcome = f"actions={action_summary}"
            if reasoning:
                self._knowledge_distiller.add_experience(
                    content=reasoning[:300],
                    context=f"tick={ctx.tick_id} trigger={ctx.trigger} alerts={len(ctx.active_alerts)}",
                    outcome=outcome,
                    tags=["brain_tick", ctx.trigger],
                )

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _rotate_session(self) -> None:
        self._session_id = str(uuid.uuid4())
        self._tick_count = 0
        self._total_tokens_used = 0
        logger.info("Brain session rotated", session_id=self._session_id)

    def _track_token_usage(self, response: Any) -> None:
        usage = getattr(response, "usage", None) or (response.get("usage") if isinstance(response, dict) else None)
        if usage and isinstance(usage, dict):
            self._total_tokens_used += usage.get("total_tokens", 0)

    def _emit_thinking(self, phase: OODAPhase, message: str, meta: dict | None = None) -> None:
        for listener in self._thinking_listeners:
            try:
                listener(phase, message, meta)
            except Exception:
                pass

    def _register_perception_sources(self) -> None:
        if self._event_bus is None:
            return
        # register as perception source
        try:
            self._event_bus.register_source("brain", {"type": "brain", "description": "Autonomous Brain"})
        except Exception:
            pass

    @staticmethod
    def _compress_alerts(alerts: list[dict]) -> str:
        return "; ".join(
            f"{a.get('severity','?')}: {a.get('message','')[:60]}" for a in alerts[:10]
        )

    @staticmethod
    def _compress_predictions(predictions: list[dict]) -> str:
        return "; ".join(str(p)[:80] for p in predictions[:5])

    @staticmethod
    def _compress_patterns(patterns: list[dict]) -> str:
        return "; ".join(str(p)[:80] for p in patterns[:5])

    def on_thinking(self, listener: Callable[..., Any]) -> None:
        self._thinking_listeners.append(listener)

    def remove_on_thinking(self, listener: Callable[..., Any]) -> None:
        """Remove a previously registered thinking listener."""
        try:
            self._thinking_listeners.remove(listener)
        except ValueError:
            pass

    # ------------------------------------------------------------------
    # 事件路由 & 背压
    # ------------------------------------------------------------------

    def _on_event(self, event: dict[str, Any]) -> None:
        """事件总线回调 — 将事件路由到高优先级或普通队列。"""
        if self._state == "cooldown":
            logger.debug("brain_event_dropped_cooldown", event_type=event.get("type"))
            return

        severity = event.get("severity", "info")
        if severity in ("critical", "high"):
            self._high_priority_queue.enqueue(event)
        else:
            self._event_queue.enqueue(event)

        # 检查背压
        total = self._high_priority_queue.size + self._event_queue.size
        if total >= self._config.high_water_mark:
            self._apply_backpressure()

    def _apply_backpressure(self) -> None:
        """背压控制 — 丢弃普通队列中最低优先级事件直到低水位。"""
        target = self._config.low_water_mark
        total = self._high_priority_queue.size + self._event_queue.size
        while total > target and not self._event_queue.is_empty:
            dropped = self._event_queue.drop_lowest_priority()
            if dropped:
                self._dropped_total += 1
                label = dropped.get("type", "unknown")
                self._dropped_by_label[label] = self._dropped_by_label.get(label, 0) + 1
                total -= 1
            else:
                break
        if self._dropped_total:
            logger.warning("brain_backpressure_applied", dropped_total=self._dropped_total)

    # ------------------------------------------------------------------
    # Cooldown
    # ------------------------------------------------------------------

    def _enter_cooldown(self, reason: str = "error") -> None:
        """进入冷却状态 — 暂停处理事件，cooldown_s 后自动恢复。"""
        if self._state == "cooldown":
            return
        self._state = "cooldown"
        logger.warning("brain_entering_cooldown", reason=reason, duration_s=self._config.cooldown_s)
        if self._event_bus:
            self._event_bus.emit("brain_cooldown", {"reason": reason, "duration_s": self._config.cooldown_s})

        async def _recover() -> None:
            await asyncio.sleep(self._config.cooldown_s)
            if self._running:
                self._state = "running"
                logger.info("brain_cooldown_recovered")

        self._cooldown_task = asyncio.create_task(_recover())

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

    def _start_heartbeat(self) -> None:
        """启动心跳任务 — 定期发布 brain_heartbeat 事件。"""
        if self._heartbeat_task and not self._heartbeat_task.done():
            return

        async def _heartbeat_loop() -> None:
            while self._running:
                try:
                    await asyncio.sleep(self._config.heartbeat_interval_s)
                    if self._event_bus and self._running:
                        self._event_bus.emit("brain_heartbeat", {
                            "session_id": self._session_id,
                            "state": self._state,
                            "tick_count": self._tick_count,
                            "queue_depth": self.get_queue_depth(),
                            "last_tick_duration_ms": self._last_tick_duration_ms,
                            "timestamp": time.time(),
                        })
                except asyncio.CancelledError:
                    break
                except Exception:
                    logger.debug("heartbeat_emit_error")

        self._heartbeat_task = asyncio.create_task(_heartbeat_loop())

    def _stop_heartbeat(self) -> None:
        """停止心跳任务。"""
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

    # ------------------------------------------------------------------
    # Episodic memory 持久化
    # ------------------------------------------------------------------

    async def _persist_memory(self) -> None:
        """将 episodic memory 持久化到 PostgreSQL。"""
        if not self._datastore or not self._episodes:
            return
        try:
            import json as _json
            payload = _json.dumps(
                [{"content": e.content, "context": e.context, "source": e.source,
                  "timestamp": e.timestamp, "relevance": e.relevance}
                 for e in self._episodes],
                ensure_ascii=False,
            )
            await self._datastore.execute(
                """INSERT INTO ai_ops_kv (key, value, updated_at)
                   VALUES ($1, $2, NOW())
                   ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()""",
                (f"brain_memory:{self._session_id}", payload),
            )
            logger.debug("brain_memory_persisted", episodes=len(self._episodes))
        except Exception as exc:
            logger.warning("brain_memory_persist_failed", error=str(exc))

    async def _load_memory(self) -> None:
        """从 PostgreSQL 恢复最近一次 episodic memory。"""
        if not self._datastore:
            return
        try:
            row = await self._datastore.query_one(
                """SELECT value FROM ai_ops_kv
                   WHERE key LIKE 'brain_memory:%'
                   ORDER BY updated_at DESC LIMIT 1""",
            )
            if row and row.get("value"):
                import json as _json
                items = _json.loads(row["value"])
                for item in items[-self._config.memory_max_episodes:]:
                    self._episodes.append(EpisodicMemory(
                        content=item.get("content", ""),
                        context=item.get("context", ""),
                        source=item.get("source", "restored"),
                        timestamp=item.get("timestamp", 0),
                        relevance=item.get("relevance", 0.5),
                    ))
                logger.info("brain_memory_loaded", episodes=len(self._episodes))
        except Exception as exc:
            logger.debug("brain_memory_load_skipped", reason=str(exc))

    async def _persist_episodic_memory(self, tick_result: dict[str, Any]) -> None:
        """将单次 tick 结果保存为 episodic memory 条目。"""
        summary = tick_result.get("summary", "")
        if summary:
            self._add_episode(summary, f"tick_{self._tick_count}", "tick_result")

    # ------------------------------------------------------------------
    # 公共 API — 队列 & 统计
    # ------------------------------------------------------------------

    def get_queue_depth(self) -> dict[str, int]:
        """返回当前队列深度。"""
        return {
            "high_priority": self._high_priority_queue.size,
            "normal": self._event_queue.size,
            "total": self._high_priority_queue.size + self._event_queue.size,
        }

    def get_dropped_events_counter(self) -> dict[str, Any]:
        """返回被丢弃事件的统计。"""
        return {
            "total": self._dropped_total,
            "by_label": dict(self._dropped_by_label),
        }
