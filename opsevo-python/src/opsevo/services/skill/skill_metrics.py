"""
SkillMetrics — Skill 使用指标追踪

记录和分析 Skill 的使用情况、成功率、响应时间等指标，
以及工具级别的健康度监控（熔断器、失败模式分析）。
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class SkillUsageMetrics:
    """单个 Skill 的使用指标。"""

    skill_name: str
    usage_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_response_time: float = 0.0
    positive_feedback: int = 0
    negative_feedback: int = 0
    last_used: float | None = None
    match_type_counts: dict[str, int] = field(default_factory=dict)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total > 0 else 0.0

    @property
    def avg_response_time(self) -> float:
        total = self.success_count + self.failure_count
        return self.total_response_time / total if total > 0 else 0.0


@dataclass
class ToolUsageMetrics:
    """单个工具的使用指标。"""

    tool_name: str
    total_calls: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_response_time: float = 0.0
    last_used: float | None = None
    health_score: float = 100.0
    circuit_breaker_open: bool = False
    failure_patterns: list[dict[str, Any]] = field(default_factory=list)
    used_by_skills: set[str] = field(default_factory=set)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total > 0 else 1.0


@dataclass
class ToolHealthStatus:
    """工具健康状态。"""

    tool_name: str
    health_score: float
    status: str  # healthy | degraded | unhealthy
    circuit_breaker_open: bool
    success_rate: float
    total_calls: int
    recent_failures: int


class SkillMetricsConfig:
    """指标配置。"""

    def __init__(
        self,
        metrics_file: str = "data/ai-ops/skills/metrics.json",
        auto_save_interval: int = 60_000,
        max_history: int = 10_000,
    ) -> None:
        self.metrics_file = metrics_file
        self.auto_save_interval = auto_save_interval
        self.max_history = max_history


class SkillMetrics:
    """Skill 使用指标追踪服务。"""

    def __init__(self, config: SkillMetricsConfig | None = None) -> None:
        self.config = config or SkillMetricsConfig()
        self._metrics: dict[str, SkillUsageMetrics] = {}
        self._tool_metrics: dict[str, ToolUsageMetrics] = {}
        self._auto_save_task: asyncio.Task[None] | None = None
        self._initialized = False

    # ------------------------------------------------------------------
    # 初始化 / 持久化
    # ------------------------------------------------------------------

    async def load(self) -> None:
        """从文件加载指标数据。"""
        path = Path(self.config.metrics_file)
        if not path.exists():
            self._initialized = True
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if "skills" in data:
                for name, raw in data["skills"].items():
                    m = SkillUsageMetrics(skill_name=name)
                    m.usage_count = raw.get("usageCount", 0)
                    m.success_count = raw.get("successCount", 0)
                    m.failure_count = raw.get("failureCount", 0)
                    m.total_response_time = raw.get("totalResponseTime", 0.0)
                    m.positive_feedback = raw.get("positiveFeedback", 0)
                    m.negative_feedback = raw.get("negativeFeedback", 0)
                    m.last_used = raw.get("lastUsed")
                    m.match_type_counts = raw.get("matchTypeCounts", {})
                    self._metrics[name] = m
            self._initialized = True
            logger.info("SkillMetrics loaded", skill_count=len(self._metrics))
        except Exception as exc:
            logger.error("Failed to load SkillMetrics", error=str(exc))
            self._initialized = True

    async def flush(self) -> None:
        """持久化指标到文件。"""
        path = Path(self.config.metrics_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {"version": 2, "skills": {}, "tools": {}}
        for name, m in self._metrics.items():
            data["skills"][name] = {
                "usageCount": m.usage_count,
                "successCount": m.success_count,
                "failureCount": m.failure_count,
                "totalResponseTime": m.total_response_time,
                "positiveFeedback": m.positive_feedback,
                "negativeFeedback": m.negative_feedback,
                "lastUsed": m.last_used,
                "matchTypeCounts": m.match_type_counts,
            }
        for name, t in self._tool_metrics.items():
            data["tools"][name] = {
                "totalCalls": t.total_calls,
                "successCount": t.success_count,
                "failureCount": t.failure_count,
                "totalResponseTime": t.total_response_time,
                "healthScore": t.health_score,
                "circuitBreakerOpen": t.circuit_breaker_open,
            }
        try:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            logger.debug("SkillMetrics flushed")
        except Exception as exc:
            logger.error("Failed to flush metrics", error=str(exc))

    # ------------------------------------------------------------------
    # Skill 指标记录
    # ------------------------------------------------------------------

    def _get_or_create(self, skill_name: str) -> SkillUsageMetrics:
        if skill_name not in self._metrics:
            self._metrics[skill_name] = SkillUsageMetrics(skill_name=skill_name)
        return self._metrics[skill_name]

    def record_usage(self, skill_name: str, match_type: str = "default") -> None:
        m = self._get_or_create(skill_name)
        m.usage_count += 1
        m.last_used = time.time()
        m.match_type_counts[match_type] = m.match_type_counts.get(match_type, 0) + 1

    def record_completion(
        self, skill_name: str, success: bool, response_time: float
    ) -> None:
        m = self._get_or_create(skill_name)
        if success:
            m.success_count += 1
        else:
            m.failure_count += 1
        m.total_response_time += response_time

    def record_feedback(self, skill_name: str, positive: bool) -> None:
        m = self._get_or_create(skill_name)
        if positive:
            m.positive_feedback += 1
        else:
            m.negative_feedback += 1

    def get_metrics(self, skill_name: str) -> SkillUsageMetrics | None:
        return self._metrics.get(skill_name)

    def get_all_metrics(self) -> list[SkillUsageMetrics]:
        return list(self._metrics.values())

    def get_top_skills(self, limit: int = 10) -> list[SkillUsageMetrics]:
        return sorted(
            self._metrics.values(), key=lambda m: m.usage_count, reverse=True
        )[:limit]

    def get_overall_stats(self) -> dict[str, Any]:
        total_usage = sum(m.usage_count for m in self._metrics.values())
        total_success = sum(m.success_count for m in self._metrics.values())
        total_failure = sum(m.failure_count for m in self._metrics.values())
        return {
            "total_skills": len(self._metrics),
            "total_usage": total_usage,
            "total_success": total_success,
            "total_failure": total_failure,
            "overall_success_rate": (
                total_success / (total_success + total_failure)
                if (total_success + total_failure) > 0
                else 0.0
            ),
        }

    def reset_metrics(self, skill_name: str) -> bool:
        if skill_name in self._metrics:
            self._metrics[skill_name] = SkillUsageMetrics(skill_name=skill_name)
            return True
        return False

    def clear_all_metrics(self) -> None:
        self._metrics.clear()

    # ------------------------------------------------------------------
    # 工具指标
    # ------------------------------------------------------------------

    def _get_or_create_tool(self, tool_name: str) -> ToolUsageMetrics:
        if tool_name not in self._tool_metrics:
            self._tool_metrics[tool_name] = ToolUsageMetrics(tool_name=tool_name)
        return self._tool_metrics[tool_name]

    def record_tool_usage(self, tool_name: str, skill_name: str | None = None) -> None:
        t = self._get_or_create_tool(tool_name)
        t.total_calls += 1
        t.last_used = time.time()
        if skill_name:
            t.used_by_skills.add(skill_name)

    def record_tool_completion(
        self,
        tool_name: str,
        success: bool,
        response_time: float,
        error: str | None = None,
    ) -> None:
        t = self._get_or_create_tool(tool_name)
        if success:
            t.success_count += 1
        else:
            t.failure_count += 1
            if error:
                t.failure_patterns.append(
                    {"error": error, "timestamp": time.time()}
                )
                # 保留最近 100 条
                if len(t.failure_patterns) > 100:
                    t.failure_patterns = t.failure_patterns[-100:]
        t.total_response_time += response_time
        self._update_tool_health(tool_name)

    def _update_tool_health(self, tool_name: str) -> None:
        t = self._tool_metrics.get(tool_name)
        if not t:
            return
        # 简单健康分计算：基于成功率
        t.health_score = t.success_rate * 100

    def open_circuit_breaker(self, tool_name: str) -> None:
        t = self._get_or_create_tool(tool_name)
        t.circuit_breaker_open = True
        logger.warn("Circuit breaker opened", tool=tool_name)

    def close_circuit_breaker(self, tool_name: str) -> None:
        t = self._get_or_create_tool(tool_name)
        t.circuit_breaker_open = False
        logger.info("Circuit breaker closed", tool=tool_name)

    def get_tool_metrics(self, tool_name: str) -> ToolUsageMetrics | None:
        return self._tool_metrics.get(tool_name)

    def get_all_tool_metrics(self) -> list[ToolUsageMetrics]:
        return list(self._tool_metrics.values())

    def get_tool_health_status(self, tool_name: str) -> ToolHealthStatus | None:
        t = self._tool_metrics.get(tool_name)
        if not t:
            return None
        status = "healthy"
        if t.health_score < 50:
            status = "unhealthy"
        elif t.health_score < 80:
            status = "degraded"
        recent = [
            p for p in t.failure_patterns if time.time() - p.get("timestamp", 0) < 3600
        ]
        return ToolHealthStatus(
            tool_name=tool_name,
            health_score=t.health_score,
            status=status,
            circuit_breaker_open=t.circuit_breaker_open,
            success_rate=t.success_rate,
            total_calls=t.total_calls,
            recent_failures=len(recent),
        )

    def get_all_tool_health_status(self) -> list[ToolHealthStatus]:
        return [
            hs
            for name in self._tool_metrics
            if (hs := self.get_tool_health_status(name)) is not None
        ]

    def get_unhealthy_tools(self) -> list[ToolHealthStatus]:
        return [hs for hs in self.get_all_tool_health_status() if hs.status == "unhealthy"]

    def get_tool_priority_ranking(self) -> list[dict[str, Any]]:
        scored = []
        for name, t in self._tool_metrics.items():
            score = t.health_score * 0.5 + t.success_rate * 50
            scored.append({"tool_name": name, "score": round(score, 2)})
        scored.sort(key=lambda x: x["score"], reverse=True)
        for i, item in enumerate(scored):
            item["rank"] = i + 1
        return scored

    def analyze_failure_patterns(self, tool_name: str) -> dict[str, Any]:
        t = self._tool_metrics.get(tool_name)
        if not t:
            return {"patterns": [], "recommendations": []}
        # 按错误类型分组
        pattern_counts: dict[str, int] = {}
        for p in t.failure_patterns:
            err = p.get("error", "unknown")
            pattern_counts[err] = pattern_counts.get(err, 0) + 1
        patterns = [
            {"error": err, "count": cnt}
            for err, cnt in sorted(pattern_counts.items(), key=lambda x: -x[1])
        ]
        return {"patterns": patterns, "recommendations": []}

    def get_global_failure_stats(self) -> dict[str, Any]:
        total_calls = sum(t.total_calls for t in self._tool_metrics.values())
        total_failures = sum(t.failure_count for t in self._tool_metrics.values())
        return {
            "total_tools": len(self._tool_metrics),
            "total_calls": total_calls,
            "total_failures": total_failures,
            "failure_rate": total_failures / total_calls if total_calls > 0 else 0.0,
        }

    def reset_tool_metrics(self, tool_name: str) -> bool:
        if tool_name in self._tool_metrics:
            self._tool_metrics[tool_name] = ToolUsageMetrics(tool_name=tool_name)
            return True
        return False

    def clear_all_tool_metrics(self) -> None:
        self._tool_metrics.clear()

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def is_initialized(self) -> bool:
        return self._initialized

    async def shutdown(self) -> None:
        if self._auto_save_task and not self._auto_save_task.done():
            self._auto_save_task.cancel()
        await self.flush()
        logger.info("SkillMetrics shutdown")
