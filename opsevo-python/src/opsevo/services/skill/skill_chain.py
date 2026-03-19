"""
SkillChainManager — Skill 链式调用管理器

管理 Skill 之间的自动链式调用，包括：
- 链触发检测（基于 switchSuggestion 或响应内容）
- 链状态管理（深度限制、循环检测、超时）
- 链历史记录
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class SkillChainStep:
    """链式调用中的一个步骤。"""

    step_id: str
    skill_name: str
    trigger_reason: str
    auto_switched: bool
    started_at: float
    completed_at: float | None = None
    status: str = "running"  # running | completed | failed
    result_summary: str = ""


@dataclass
class ChainState:
    """链的运行状态。"""

    chain_id: str
    session_id: str
    initial_skill: str
    current_depth: int = 0
    steps: list[SkillChainStep] = field(default_factory=list)
    visited_skills: set[str] = field(default_factory=set)
    status: str = "active"  # active | completed | failed | timeout
    started_at: float = field(default_factory=time.time)


@dataclass
class ChainTriggerResult:
    """链触发检测结果。"""

    should_chain: bool
    target_skill: str | None = None
    trigger_reason: str = ""
    auto_switch: bool = False


class SkillChainConfig:
    """链式调用配置。"""

    def __init__(
        self,
        enabled: bool = True,
        max_chain_depth: int = 5,
        chain_timeout_ms: int = 300_000,
        allow_circular: bool = False,
    ) -> None:
        self.enabled = enabled
        self.max_chain_depth = max_chain_depth
        self.chain_timeout_ms = chain_timeout_ms
        self.allow_circular = allow_circular


class SkillChainManager:
    """Skill 链式调用管理器。"""

    def __init__(self, config: SkillChainConfig | None = None) -> None:
        self.config = config or SkillChainConfig()
        self._active_chains: dict[str, ChainState] = {}
        logger.info("SkillChainManager created", config=vars(self.config))

    # ------------------------------------------------------------------
    # 链触发检测
    # ------------------------------------------------------------------

    def detect_chain_trigger(
        self,
        session_id: str,
        current_skill: str,
        response: str,
        switch_suggestion: dict[str, Any] | None = None,
    ) -> ChainTriggerResult:
        """检测是否应触发链式调用。"""
        if not self.config.enabled:
            return ChainTriggerResult(should_chain=False)

        chain_state = self._active_chains.get(session_id)
        if chain_state and chain_state.current_depth >= self.config.max_chain_depth:
            logger.debug("Chain depth limit reached", session_id=session_id)
            return ChainTriggerResult(should_chain=False)

        # 1. 检查 switchSuggestion
        if switch_suggestion:
            result = self._check_suggestion_trigger(
                session_id, current_skill, switch_suggestion
            )
            if result.should_chain:
                return result

        return ChainTriggerResult(should_chain=False)

    def _check_suggestion_trigger(
        self,
        session_id: str,
        current_skill: str,
        suggestion: dict[str, Any],
    ) -> ChainTriggerResult:
        target = suggestion.get("suggestedSkill") or suggestion.get("suggested_skill")
        if not target or target == current_skill:
            return ChainTriggerResult(should_chain=False)

        chain_state = self._active_chains.get(session_id)
        if chain_state and not self.config.allow_circular:
            if target in chain_state.visited_skills:
                logger.debug("Circular chain detected", target=target)
                return ChainTriggerResult(should_chain=False)

        reason = suggestion.get("reason", "switchSuggestion trigger")
        return ChainTriggerResult(
            should_chain=True,
            target_skill=target,
            trigger_reason=reason,
            auto_switch=True,
        )

    # ------------------------------------------------------------------
    # 链状态管理
    # ------------------------------------------------------------------

    def start_chain(self, session_id: str, initial_skill: str) -> ChainState:
        chain_state = ChainState(
            chain_id=str(uuid.uuid4()),
            session_id=session_id,
            initial_skill=initial_skill,
        )
        chain_state.visited_skills.add(initial_skill)
        self._active_chains[session_id] = chain_state
        logger.info("Chain started", chain_id=chain_state.chain_id, skill=initial_skill)
        return chain_state

    def add_chain_step(
        self,
        session_id: str,
        skill_name: str,
        trigger_reason: str,
        auto_switched: bool,
    ) -> SkillChainStep | None:
        chain_state = self._active_chains.get(session_id)
        if not chain_state:
            return None

        if chain_state.current_depth >= self.config.max_chain_depth:
            return None

        step = SkillChainStep(
            step_id=str(uuid.uuid4()),
            skill_name=skill_name,
            trigger_reason=trigger_reason,
            auto_switched=auto_switched,
            started_at=time.time(),
        )
        chain_state.steps.append(step)
        chain_state.current_depth += 1
        chain_state.visited_skills.add(skill_name)
        return step

    def complete_current_step(
        self, session_id: str, result_summary: str = ""
    ) -> None:
        chain_state = self._active_chains.get(session_id)
        if not chain_state or not chain_state.steps:
            return
        step = chain_state.steps[-1]
        step.completed_at = time.time()
        step.status = "completed"
        step.result_summary = result_summary

    def end_chain(
        self, session_id: str, status: str = "completed"
    ) -> ChainState | None:
        chain_state = self._active_chains.pop(session_id, None)
        if chain_state:
            chain_state.status = status
            logger.info(
                "Chain ended",
                chain_id=chain_state.chain_id,
                status=status,
                depth=chain_state.current_depth,
            )
        return chain_state

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get_chain_state(self, session_id: str) -> ChainState | None:
        return self._active_chains.get(session_id)

    def is_chain_timeout(self, session_id: str) -> bool:
        chain_state = self._active_chains.get(session_id)
        if not chain_state:
            return False
        elapsed_ms = (time.time() - chain_state.started_at) * 1000
        return elapsed_ms > self.config.chain_timeout_ms

    def cleanup_timeout_chains(self) -> int:
        timed_out = [
            sid
            for sid in self._active_chains
            if self.is_chain_timeout(sid)
        ]
        for sid in timed_out:
            self.end_chain(sid, status="timeout")
        return len(timed_out)

    def get_chain_history(self, session_id: str) -> list[SkillChainStep]:
        chain_state = self._active_chains.get(session_id)
        return list(chain_state.steps) if chain_state else []

    def get_chain_stats(self) -> dict[str, Any]:
        return {
            "active_chains": len(self._active_chains),
            "chains": {
                sid: {
                    "chain_id": cs.chain_id,
                    "depth": cs.current_depth,
                    "status": cs.status,
                }
                for sid, cs in self._active_chains.items()
            },
        }

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self.config, k):
                setattr(self.config, k, v)
        logger.info("SkillChainManager config updated")
