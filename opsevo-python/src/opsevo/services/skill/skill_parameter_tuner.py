"""
SkillParameterTuner — Skill 参数自动调优服务

收集参数使用统计，分析参数组合与成功率的关系，生成优化建议。
支持 A/B 测试和 PostgreSQL 持久化。
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog

from opsevo.services.skill.skill_registry import SkillRegistry
from opsevo.services.skill.skill_metrics import SkillMetrics

logger = structlog.get_logger(__name__)


@dataclass
class ParameterUsageRecord:
    """参数使用记录。"""

    record_id: str
    skill_name: str
    parameters: dict[str, Any]
    success: bool
    response_time: float
    timestamp: float = field(default_factory=time.time)


@dataclass
class ParameterRecommendation:
    """参数优化建议。"""

    recommendation_id: str
    skill_name: str
    parameter_name: str
    current_value: Any
    recommended_value: Any
    reason: str
    confidence: float
    status: str = "pending"  # pending | applied | rejected
    created_at: float = field(default_factory=time.time)


@dataclass
class ABTestConfig:
    """A/B 测试配置。"""

    test_id: str
    skill_name: str
    parameter_name: str
    control_value: Any
    experiment_value: Any
    traffic_split: float = 0.5
    status: str = "active"  # active | completed | cancelled
    control_stats: dict[str, int] = field(
        default_factory=lambda: {"success": 0, "failure": 0}
    )
    experiment_stats: dict[str, int] = field(
        default_factory=lambda: {"success": 0, "failure": 0}
    )
    created_at: float = field(default_factory=time.time)


class ParameterTunerConfig:
    """调优器配置。"""

    def __init__(
        self,
        min_sample_size: int = 20,
        significance_threshold: float = 0.05,
        auto_save_interval: int = 120_000,
        data_file: str = "data/ai-ops/skills/parameter-tuning.json",
    ) -> None:
        self.min_sample_size = min_sample_size
        self.significance_threshold = significance_threshold
        self.auto_save_interval = auto_save_interval
        self.data_file = data_file


class SkillParameterTuner:
    """Skill 参数自动调优服务。"""

    def __init__(
        self,
        registry: SkillRegistry,
        metrics: SkillMetrics,
        config: ParameterTunerConfig | None = None,
    ) -> None:
        self.config = config or ParameterTunerConfig()
        self._registry = registry
        self._metrics = metrics
        self._datastore: Any = None
        self._usage_records: list[ParameterUsageRecord] = []
        self._recommendations: dict[str, list[ParameterRecommendation]] = {}
        self._ab_tests: dict[str, ABTestConfig] = {}
        self._initialized = False
        logger.info("SkillParameterTuner created")

    def set_datastore(self, datastore: Any) -> None:
        self._datastore = datastore
        logger.info("SkillParameterTuner: DataStore injected")

    # ------------------------------------------------------------------
    # 初始化 / 持久化
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        try:
            await self._load_data()
            self._initialized = True
            logger.info(
                "SkillParameterTuner initialized",
                records=len(self._usage_records),
                recommendations=sum(len(v) for v in self._recommendations.values()),
            )
        except Exception as exc:
            logger.error("Failed to initialize SkillParameterTuner", error=str(exc))
            self._initialized = True  # 允许内存模式运行

    async def _load_data(self) -> None:
        if self._datastore:
            # 从 PostgreSQL 加载
            try:
                rows = await self._datastore.query(
                    "SELECT data FROM skill_parameter_tuning WHERE id = $1",
                    ["tuning_data"],
                )
                if rows:
                    data = rows[0]["data"]
                    if isinstance(data, str):
                        data = json.loads(data)
                    self._load_from_dict(data)
                    return
            except Exception:
                logger.debug("No DB tuning data, trying file")

        # 从文件加载
        path = Path(self.config.data_file)
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                self._load_from_dict(data)
            except Exception as exc:
                logger.error("Failed to load tuning data from file", error=str(exc))

    def _load_from_dict(self, data: dict[str, Any]) -> None:
        for raw in data.get("records", []):
            self._usage_records.append(
                ParameterUsageRecord(
                    record_id=raw.get("recordId", str(uuid.uuid4())),
                    skill_name=raw["skillName"],
                    parameters=raw.get("parameters", {}),
                    success=raw.get("success", True),
                    response_time=raw.get("responseTime", 0),
                    timestamp=raw.get("timestamp", 0),
                )
            )

    async def _save_data(self) -> None:
        data: dict[str, Any] = {
            "records": [
                {
                    "recordId": r.record_id,
                    "skillName": r.skill_name,
                    "parameters": r.parameters,
                    "success": r.success,
                    "responseTime": r.response_time,
                    "timestamp": r.timestamp,
                }
                for r in self._usage_records[-1000:]  # 保留最近 1000 条
            ],
        }
        if self._datastore:
            try:
                await self._datastore.execute(
                    """INSERT INTO skill_parameter_tuning (id, data, updated_at)
                       VALUES ($1, $2, NOW())
                       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()""",
                    ["tuning_data", json.dumps(data, ensure_ascii=False)],
                )
                return
            except Exception as exc:
                logger.error("Failed to save tuning data to DB", error=str(exc))

        path = Path(self.config.data_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------------
    # 记录与分析
    # ------------------------------------------------------------------

    def record_usage(
        self,
        skill_name: str,
        parameters: dict[str, Any],
        success: bool,
        response_time: float,
    ) -> None:
        record = ParameterUsageRecord(
            record_id=str(uuid.uuid4()),
            skill_name=skill_name,
            parameters=parameters,
            success=success,
            response_time=response_time,
        )
        self._usage_records.append(record)
        self._update_ab_test_stats(record)

    def generate_recommendations(self, skill_name: str) -> list[ParameterRecommendation]:
        """分析参数使用记录，生成优化建议。"""
        records = [r for r in self._usage_records if r.skill_name == skill_name]
        if len(records) < self.config.min_sample_size:
            return []

        recommendations: list[ParameterRecommendation] = []
        # 收集所有参数名
        param_names: set[str] = set()
        for r in records:
            param_names.update(r.parameters.keys())

        for param in param_names:
            rec = self._analyze_and_recommend(skill_name, param, records)
            if rec:
                recommendations.append(rec)

        self._recommendations[skill_name] = recommendations
        return recommendations

    def _analyze_and_recommend(
        self,
        skill_name: str,
        param_name: str,
        records: list[ParameterUsageRecord],
    ) -> ParameterRecommendation | None:
        # 按参数值分组统计成功率
        value_stats: dict[str, dict[str, int]] = {}
        for r in records:
            val = str(r.parameters.get(param_name, ""))
            if not val:
                continue
            if val not in value_stats:
                value_stats[val] = {"success": 0, "failure": 0}
            if r.success:
                value_stats[val]["success"] += 1
            else:
                value_stats[val]["failure"] += 1

        if len(value_stats) < 2:
            return None

        # 找到最佳值
        best_val = None
        best_rate = -1.0
        current_val = None
        for val, stats in value_stats.items():
            total = stats["success"] + stats["failure"]
            if total < 3:
                continue
            rate = stats["success"] / total
            if rate > best_rate:
                best_rate = rate
                best_val = val
            if current_val is None:
                current_val = val

        if best_val is None or best_val == current_val:
            return None

        return ParameterRecommendation(
            recommendation_id=str(uuid.uuid4()),
            skill_name=skill_name,
            parameter_name=param_name,
            current_value=current_val,
            recommended_value=best_val,
            reason=f"Success rate {best_rate:.0%} vs current",
            confidence=min(best_rate, 0.95),
        )

    def get_recommendations(
        self, skill_name: str | None = None
    ) -> list[ParameterRecommendation]:
        if skill_name:
            return self._recommendations.get(skill_name, [])
        return [r for recs in self._recommendations.values() for r in recs]

    # ------------------------------------------------------------------
    # A/B 测试
    # ------------------------------------------------------------------

    def create_ab_test(
        self,
        skill_name: str,
        parameter_name: str,
        control_value: Any,
        experiment_value: Any,
        traffic_split: float = 0.5,
    ) -> ABTestConfig:
        test = ABTestConfig(
            test_id=str(uuid.uuid4()),
            skill_name=skill_name,
            parameter_name=parameter_name,
            control_value=control_value,
            experiment_value=experiment_value,
            traffic_split=traffic_split,
        )
        self._ab_tests[test.test_id] = test
        logger.info("A/B test created", test_id=test.test_id, skill=skill_name)
        return test

    def get_ab_test(self, test_id: str) -> ABTestConfig | None:
        return self._ab_tests.get(test_id)

    def get_active_ab_tests(
        self, skill_name: str | None = None
    ) -> list[ABTestConfig]:
        tests = [t for t in self._ab_tests.values() if t.status == "active"]
        if skill_name:
            tests = [t for t in tests if t.skill_name == skill_name]
        return tests

    def should_use_experiment(self, test_id: str) -> bool:
        test = self._ab_tests.get(test_id)
        if not test or test.status != "active":
            return False
        import random
        return random.random() < test.traffic_split

    def _update_ab_test_stats(self, record: ParameterUsageRecord) -> None:
        for test in self._ab_tests.values():
            if test.status != "active" or test.skill_name != record.skill_name:
                continue
            param_val = record.parameters.get(test.parameter_name)
            if param_val is None:
                continue
            key = "success" if record.success else "failure"
            if str(param_val) == str(test.control_value):
                test.control_stats[key] = test.control_stats.get(key, 0) + 1
            elif str(param_val) == str(test.experiment_value):
                test.experiment_stats[key] = test.experiment_stats.get(key, 0) + 1

    def evaluate_ab_test(self, test_id: str) -> dict[str, Any]:
        test = self._ab_tests.get(test_id)
        if not test:
            return {"error": "Test not found"}
        c_total = test.control_stats.get("success", 0) + test.control_stats.get("failure", 0)
        e_total = test.experiment_stats.get("success", 0) + test.experiment_stats.get("failure", 0)
        c_rate = test.control_stats.get("success", 0) / c_total if c_total > 0 else 0
        e_rate = test.experiment_stats.get("success", 0) / e_total if e_total > 0 else 0
        return {
            "test_id": test_id,
            "control_rate": round(c_rate, 4),
            "experiment_rate": round(e_rate, 4),
            "control_samples": c_total,
            "experiment_samples": e_total,
            "winner": "experiment" if e_rate > c_rate else "control",
            "significant": c_total >= self.config.min_sample_size
            and e_total >= self.config.min_sample_size,
        }

    def end_ab_test(self, test_id: str, status: str = "completed") -> bool:
        test = self._ab_tests.get(test_id)
        if not test:
            return False
        test.status = status
        return True

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get_usage_records(
        self, skill_name: str | None = None, limit: int = 100
    ) -> list[ParameterUsageRecord]:
        records = self._usage_records
        if skill_name:
            records = [r for r in records if r.skill_name == skill_name]
        return records[-limit:]

    def is_initialized(self) -> bool:
        return self._initialized

    async def shutdown(self) -> None:
        await self._save_data()
        logger.info("SkillParameterTuner shutdown")
