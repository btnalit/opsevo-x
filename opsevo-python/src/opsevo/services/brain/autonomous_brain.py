"""
AutonomousBrainService — OODA 循环（Observe-Orient-Decide-Act-Learn）

- tick 驱动执行，APScheduler 定时触发
- 会话轮换（每 20 次 tick）
- token 预算硬阻断
- 感知源注册与上下文收集
- 情景记忆与衰减
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)


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


@dataclass
class BrainConfig:
    tick_interval_s: float = 60.0
    session_max_ticks: int = 20
    token_budget: int = 100_000
    memory_max_episodes: int = 200
    memory_decay_rate: float = 0.05
    context_timeout_s: float = 10.0
    max_concurrent_collections: int = 5


class AutonomousBrainService:
    """OODA 循环自主大脑服务。"""

    # Progressive Disclosure: tools available per OODA phase
    OBSERVE_TOOLS: frozenset[str] = frozenset({
        "query_device", "search_knowledge", "analyze_alert",
        "list_skills", "list_mcp_servers", "collect_metrics",
    })
    ACT_TOOLS: frozenset[str] = frozenset({
        "query_device", "search_knowledge", "analyze_alert",
        "list_skills", "list_mcp_servers", "collect_metrics",
        "execute_command", "update_config", "create_remediation",
        "invoke_skill", "send_notification", "schedule_task",
        "create_skill", "configure_mcp_server",
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
    ) -> None:
        self._config = config or BrainConfig()
        self._event_bus = event_bus
        self._datastore = datastore
        self._brain_tools = brain_tools
        self._adapter_pool = adapter_pool
        self._perception_cache = perception_cache
        self._tool_registry = tool_registry
        self._tool_search = tool_search

        self._running = False
        self._tick_task: asyncio.Task[None] | None = None
        self._tick_count = 0
        self._session_id = str(uuid.uuid4())
        self._total_tokens_used = 0
        self._episodes: list[EpisodicMemory] = []
        self._notes: list[str] = []
        self._thinking_listeners: list[Callable[..., Any]] = []
        self._skill_factory: Any = None

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
        self._session_id = str(uuid.uuid4())
        self._tick_count = 0
        self._total_tokens_used = 0
        self._register_perception_sources()
        self._tick_task = asyncio.create_task(self._tick_loop())
        logger.info("AutonomousBrainService started", session_id=self._session_id)

    def stop(self) -> None:
        self._running = False
        if self._tick_task and not self._tick_task.done():
            self._tick_task.cancel()
            self._tick_task = None
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

        try:
            # OODA phases
            self._emit_thinking(OODAPhase.OBSERVE, "Gathering context...")
            ctx = await self._gather_context(tick_id, trigger)

            self._emit_thinking(OODAPhase.ORIENT, "Analyzing situation...")
            prompt = self._build_prompt(ctx, ooda_phase=OODAPhase.DECIDE)

            self._emit_thinking(OODAPhase.DECIDE, "Making decisions...")
            response = await self._call_ai(prompt, ctx)

            self._emit_thinking(OODAPhase.ACT, "Executing actions...")
            await self._execute_actions(response, ctx)

            self._emit_thinking(OODAPhase.LEARN, "Recording learnings...")
            self._record_learning(response, ctx)

            self._decay_memory()
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
        if self._adapter_pool is None:
            return {"actions": [], "reasoning": "No AI adapter available"}
        try:
            adapter = await self._adapter_pool.get_adapter()

            # Build merged tool schemas: brain_tools + registry external tools
            tool_schemas: list[dict] | None = None
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
                    # Only include non-local (external/skill) tools from registry
                    registry_schemas = [
                        td for td in registry_defs if td.get("source") != "local"
                    ]
                except Exception:
                    logger.warning("Failed to get tool definitions from tool_registry")

            # Merge and dedup by name (brain_tools take priority)
            merged = list(brain_schemas)
            seen_names = {
                s.get("function", {}).get("name", "") for s in merged
            }
            for rs in registry_schemas:
                name = rs.get("function", {}).get("name", "")
                if name and name not in seen_names:
                    seen_names.add(name)
                    merged.append(rs)

            if merged:
                tool_schemas = merged

            # Apply ToolSearchMeta if available (Req 4.1, 4.4)
            if self._tool_search is not None and self._tool_search.should_use_search():
                tool_schemas = self._tool_search.get_exposed_tools()

            result = await adapter.chat(
                messages=[{"role": "user", "content": prompt}],
                tools=tool_schemas,
            )
            self._track_token_usage(result)

            # Handle native tool_calls in response
            tool_calls = self._extract_tool_calls(result)
            if tool_calls:
                await self._handle_tool_calls(tool_calls, ctx)

            return result
        except Exception:
            logger.exception("Brain AI call failed")
            return {"actions": [], "reasoning": "AI call failed"}

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
