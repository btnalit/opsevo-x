"""RAGEngine — 检索增强生成引擎 (统一编排层)

结合向量检索和 LLM 生成能力，提供增强的 AI 分析。
移植自 TS backend ragEngine.ts，适配 Python 架构。

核心功能:
- query(): 通用 RAG 查询
- analyze_alert(): 增强告警分析 (Agentic RAG)
- generate_remediation(): 增强修复方案生成
- assess_config_risk(): 配置变更风险评估
- analyze_root_cause(): 增强根因分析 (带并发控制)
- 双缓存: 告警分析缓存 + 根因分析缓存 (TTL 30min)
- RAG 并发控制: 通过 ConcurrencyController 限制并发分析数
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import structlog

from opsevo.services.ai_ops.concurrency_controller import (
    ConcurrencyConfig,
    ConcurrencyController,
)
from opsevo.services.rag.knowledge_base import KnowledgeBase

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# 配置 & 类型
# ---------------------------------------------------------------------------

DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000  # 30 min


@dataclass
class RAGConfig:
    top_k: int = 5
    min_score: float = 0.7
    alert_min_score: float = 0.75
    cross_type_min_score: float = 0.85
    recency_weight: float = 0.2
    max_context_length: int = 4000
    include_metadata: bool = True


@dataclass
class RAGConcurrencyConfig:
    max_concurrent: int = 3
    max_queue_size: int = 50
    analysis_timeout: float = 60.0


@dataclass
class RAGStats:
    queries_processed: int = 0
    avg_retrieval_time: float = 0.0
    avg_relevance_score: float = 0.0
    cache_hits: int = 0
    fallback_count: int = 0


@dataclass
class _CacheEntry:
    data: Any
    timestamp: float  # ms
    ttl: float  # ms



class RAGEngine:
    """检索增强生成引擎 — 统一编排层。"""

    def __init__(
        self,
        knowledge_base: KnowledgeBase,
        ai_analyzer: Any = None,
        feedback_service: Any = None,
        rule_evolution_service: Any = None,
        config: RAGConfig | None = None,
        concurrency_config: RAGConcurrencyConfig | None = None,
    ) -> None:
        self._kb = knowledge_base
        self._ai = ai_analyzer
        self._feedback = feedback_service
        self._rule_evo = rule_evolution_service
        self._config = config or RAGConfig()
        self._conc_config = concurrency_config or RAGConcurrencyConfig()

        self._initialized = False
        self._stats = RAGStats()

        # 告警分析缓存
        self._analysis_cache: dict[str, _CacheEntry] = {}
        self._analysis_cache_stats = {"hits": 0, "misses": 0}

        # 根因分析缓存
        self._root_cause_cache: dict[str, _CacheEntry] = {}
        self._root_cause_cache_stats = {"hits": 0, "misses": 0}

        # 缓存清理任务
        self._cleanup_task: asyncio.Task[None] | None = None

        # RAG 并发控制器
        self._rag_controller: ConcurrencyController | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        if self._initialized:
            return
        # 初始化并发控制器
        self._rag_controller = ConcurrencyController(
            ConcurrencyConfig(
                max_concurrent=self._conc_config.max_concurrent,
                max_queue_size=self._conc_config.max_queue_size,
                task_timeout=self._conc_config.analysis_timeout,
                enable_priority_queue=True,
                enable_backpressure=True,
                backpressure_threshold=0.8,
            )
        )
        self._rag_controller.set_processor(self._execute_root_cause_analysis)
        # 启动缓存清理
        self._cleanup_task = asyncio.create_task(self._cache_cleanup_loop())
        self._initialized = True
        logger.info("rag_engine_initialized", config=self._config)

    async def shutdown(self) -> None:
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        self._analysis_cache.clear()
        self._root_cause_cache.clear()
        self._rag_controller = None
        self._initialized = False
        logger.info("rag_engine_shutdown")

    def is_initialized(self) -> bool:
        return self._initialized

    # ------------------------------------------------------------------
    # 缓存
    # ------------------------------------------------------------------

    def _get_cached(self, cache: dict[str, _CacheEntry], key: str, stats: dict[str, int]) -> Any | None:
        entry = cache.get(key)
        if not entry:
            stats["misses"] += 1
            return None
        now = time.time() * 1000
        if now - entry.timestamp > entry.ttl:
            del cache[key]
            stats["misses"] += 1
            return None
        stats["hits"] += 1
        self._stats.cache_hits += 1
        return entry.data

    def _set_cached(self, cache: dict[str, _CacheEntry], key: str, data: Any, ttl: float = DEFAULT_CACHE_TTL_MS) -> None:
        cache[key] = _CacheEntry(data=data, timestamp=time.time() * 1000, ttl=ttl)

    def invalidate_analysis_cache(self, alert_id: str | None = None) -> None:
        if alert_id:
            self._analysis_cache.pop(alert_id, None)
        else:
            self._analysis_cache.clear()

    def invalidate_root_cause_cache(self, event_id: str | None = None) -> None:
        if event_id:
            self._root_cause_cache.pop(event_id, None)
        else:
            self._root_cause_cache.clear()

    def get_analysis_cache_stats(self) -> dict[str, Any]:
        total = self._analysis_cache_stats["hits"] + self._analysis_cache_stats["misses"]
        return {
            "size": len(self._analysis_cache),
            "hits": self._analysis_cache_stats["hits"],
            "misses": self._analysis_cache_stats["misses"],
            "hit_rate": self._analysis_cache_stats["hits"] / total if total else 0,
        }

    def get_root_cause_cache_stats(self) -> dict[str, Any]:
        total = self._root_cause_cache_stats["hits"] + self._root_cause_cache_stats["misses"]
        return {
            "size": len(self._root_cause_cache),
            "hits": self._root_cause_cache_stats["hits"],
            "misses": self._root_cause_cache_stats["misses"],
            "hit_rate": self._root_cause_cache_stats["hits"] / total if total else 0,
        }

    async def _cache_cleanup_loop(self) -> None:
        """每 5 分钟清理过期缓存。"""
        while True:
            await asyncio.sleep(300)
            now = time.time() * 1000
            for cache in (self._analysis_cache, self._root_cause_cache):
                expired = [k for k, v in cache.items() if now - v.timestamp > v.ttl]
                for k in expired:
                    del cache[k]
            if expired:
                logger.debug("cache_cleanup", expired_count=len(expired))


    # ------------------------------------------------------------------
    # 统计
    # ------------------------------------------------------------------

    def _update_stats(self, retrieval_time: float, docs: list[dict[str, Any]]) -> None:
        self._stats.queries_processed += 1
        n = self._stats.queries_processed
        self._stats.avg_retrieval_time = (
            self._stats.avg_retrieval_time * (n - 1) + retrieval_time
        ) / n
        if docs:
            avg_score = sum(d.get("score", 0) for d in docs) / len(docs)
            self._stats.avg_relevance_score = (
                self._stats.avg_relevance_score * (n - 1) + avg_score
            ) / n

    def get_stats(self) -> dict[str, Any]:
        return {
            "queries_processed": self._stats.queries_processed,
            "avg_retrieval_time": round(self._stats.avg_retrieval_time, 2),
            "avg_relevance_score": round(self._stats.avg_relevance_score, 4),
            "cache_hits": self._stats.cache_hits,
            "fallback_count": self._stats.fallback_count,
        }

    def get_rag_concurrency_stats(self) -> dict[str, Any]:
        if not self._rag_controller:
            return {"active": 0, "queued": 0, "total_processed": 0, "rejected": 0, "timed_out": 0}
        s = self._rag_controller.get_status()
        return {
            "active": s.active,
            "queued": s.queued,
            "total_processed": s.total_processed,
            "rejected": s.total_dropped,
            "timed_out": s.total_timed_out,
        }

    def get_config(self) -> dict[str, Any]:
        return {
            "top_k": self._config.top_k,
            "min_score": self._config.min_score,
            "alert_min_score": self._config.alert_min_score,
            "cross_type_min_score": self._config.cross_type_min_score,
            "recency_weight": self._config.recency_weight,
            "max_context_length": self._config.max_context_length,
        }

    def update_config(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        logger.info("rag_config_updated", updates=kwargs)

    # ------------------------------------------------------------------
    # 辅助方法
    # ------------------------------------------------------------------

    def _build_context_text(self, docs: list[dict[str, Any]]) -> str:
        """构建 LLM 上下文文本，截断到 max_context_length。"""
        parts: list[str] = []
        length = 0
        for doc in docs:
            entry = doc.get("entry", doc)
            score = doc.get("score", 0)
            title = entry.get("title", "")
            content = entry.get("content", str(entry))
            meta = entry.get("metadata", {})

            text = f"【历史案例】{title}\n相似度: {score * 100:.1f}%\n"
            if self._config.include_metadata:
                ts = meta.get("timestamp", 0)
                tags = meta.get("tags", [])
                if ts:
                    from datetime import datetime, timezone
                    text += f"时间: {datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()}\n"
                if tags:
                    text += f"标签: {', '.join(tags)}\n"
            text += f"内容:\n{content}"

            if length + len(text) > self._config.max_context_length:
                remaining = self._config.max_context_length - length
                if remaining > 100:
                    parts.append(text[:remaining] + "...")
                break
            parts.append(text)
            length += len(text) + 2
        return "\n\n".join(parts)

    def _calculate_confidence(self, docs: list[dict[str, Any]]) -> float:
        if not docs:
            return 0.5
        avg_score = sum(d.get("score", 0) for d in docs) / len(docs)
        count_factor = min(1.0, len(docs) / self._config.top_k)
        return avg_score * 0.7 + count_factor * 0.3

    @staticmethod
    def _map_severity_to_risk(severity: str) -> str:
        if severity in ("emergency", "critical"):
            return "high"
        if severity == "warning":
            return "medium"
        return "low"


    # ------------------------------------------------------------------
    # 通用 RAG 查询
    # ------------------------------------------------------------------

    async def query(self, question: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        """通用 RAG 查询 — 检索知识库 + LLM 生成回答。"""
        if not question or not question.strip():
            raise ValueError("查询问题不能为空")

        start = time.time() * 1000
        status = "success"
        docs: list[dict[str, Any]] = []

        try:
            docs = await self._kb.search(question, top_k=self._config.top_k, threshold=self._config.min_score)
            if not docs:
                status = "no_results"
        except Exception as exc:
            logger.error("rag_retrieval_failed", error=str(exc))
            self._stats.fallback_count += 1
            status = "fallback"

        retrieval_time = time.time() * 1000 - start

        citations = [
            {
                "entry_id": d.get("id", ""),
                "title": d.get("title", ""),
                "relevance": d.get("score", 0),
                "excerpt": str(d.get("content", ""))[:200],
            }
            for d in docs
        ]

        if docs:
            context_text = self._build_context_text(docs)
            answer = await self._generate_answer_with_context(question, context_text, context)
            confidence = self._calculate_confidence(docs)
        else:
            answer = await self._generate_fallback_answer(question, context)
            confidence = 0.5
            if status == "success":
                status = "no_results"

        self._update_stats(retrieval_time, docs)

        return {
            "answer": answer,
            "context": {
                "query": question,
                "retrieved_documents": docs,
                "retrieval_time": retrieval_time,
                "candidates_considered": len(docs),
            },
            "citations": citations,
            "confidence": confidence,
            "status": status,
        }

    async def _generate_answer_with_context(
        self, question: str, context_text: str, extra: dict[str, Any] | None = None
    ) -> str:
        if not self._ai:
            return f"基于历史案例分析：\n{context_text[:500]}..."
        prompt = (
            f"基于以下历史案例和知识，回答问题。\n\n"
            f"## 历史案例参考\n{context_text}\n\n"
            f"## 问题\n{question}\n"
        )
        if extra:
            import json
            prompt += f"\n## 附加上下文\n{json.dumps(extra, ensure_ascii=False, default=str)[:1000]}"
        try:
            result = await self._ai.analyze("rag", {"prompt": prompt}, "rag_query")
            return result.get("result", prompt[:500])
        except Exception:
            return f"基于历史案例分析：\n{context_text[:500]}..."

    async def _generate_fallback_answer(self, question: str, context: dict[str, Any] | None = None) -> str:
        if not self._ai:
            return "无法生成分析结果，请稍后重试。"
        try:
            result = await self._ai.analyze("rag", {"question": question, **(context or {})}, "fallback")
            return result.get("result", "无法生成分析结果")
        except Exception:
            return "无法生成分析结果，请稍后重试。"


    # ------------------------------------------------------------------
    # 增强告警分析
    # ------------------------------------------------------------------

    async def analyze_alert(
        self, alert_event: dict[str, Any], metrics: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """增强告警分析 — 完整 Agentic RAG 流程。

        流程: 检查缓存 → 分类 → RAG 检索 → 跨类型回退 → 反馈获取 → LLM 深度分析 → 缓存结果
        """
        alert_id = alert_event.get("id", "")

        # Step 0: 缓存检查
        cached = self._get_cached(self._analysis_cache, alert_id, self._analysis_cache_stats)
        if cached:
            return cached

        start = time.time() * 1000
        message = alert_event.get("message", "")
        category = alert_event.get("category", "other")
        severity = alert_event.get("severity", "info")

        # Step 1: 构建查询
        query_text = f"分类: {category} 消息: {message}"

        # Step 2: RAG 检索 (同类型)
        docs = await self._kb.search(query_text, top_k=self._config.top_k + 1, threshold=self._config.alert_min_score)
        # 排除自身
        docs = [d for d in docs if d.get("id") != alert_id][: self._config.top_k]

        reference_status = "not_found"
        if docs:
            reference_status = "found"
        else:
            # Step 3: 跨类型回退
            docs = await self._kb.search(query_text, top_k=self._config.top_k + 1, threshold=self._config.cross_type_min_score)
            docs = [d for d in docs if d.get("id") != alert_id][: self._config.top_k]
            if docs:
                reference_status = "type_mismatch"

        retrieval_time = time.time() * 1000 - start

        # Step 4: 构建历史引用
        historical_refs = self._build_historical_refs(docs)

        # Step 5: 获取反馈
        feedback_info = await self._get_feedback_info(alert_event)

        # Step 6: LLM 分析
        if docs or feedback_info:
            analysis = await self._generate_enhanced_alert_analysis(
                alert_event, metrics, docs, historical_refs, reference_status, feedback_info
            )
        else:
            self._stats.fallback_count += 1
            analysis = {
                "summary": f"告警: {message}",
                "details": "首次遇到此类告警，无历史参考。",
                "recommendations": ["检查相关配置和系统状态", "记录此告警的处理过程以便后续参考"],
                "risk_level": self._map_severity_to_risk(severity),
                "confidence": 0.5,
            }

        self._update_stats(retrieval_time, docs)

        result = {
            "analysis": analysis,
            "rag_context": {
                "query": query_text,
                "retrieved_documents": docs,
                "retrieval_time": retrieval_time,
                "candidates_considered": len(docs),
            },
            "historical_references": historical_refs,
            "has_historical_reference": len(docs) > 0,
            "reference_status": reference_status,
            "feedback_info": feedback_info,
        }

        # 缓存
        self._set_cached(self._analysis_cache, alert_id, result)
        return result

    def _build_historical_refs(self, docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        refs = []
        for doc in docs:
            content = str(doc.get("content", ""))
            outcome = None
            if "成功" in content or "已解决" in content:
                outcome = "success"
            elif "部分" in content:
                outcome = "partial"
            elif "失败" in content:
                outcome = "failed"
            refs.append({
                "alert_id": doc.get("id", ""),
                "similarity": doc.get("score", 0),
                "outcome": outcome,
            })
        return refs

    async def _get_feedback_info(self, alert_event: dict[str, Any]) -> dict[str, Any] | None:
        if not self._feedback:
            return None
        try:
            alert_id = alert_event.get("id", "")
            fb = await self._feedback.get_feedback(alert_id)
            return {"alert_feedback": fb} if fb else None
        except Exception:
            return None

    async def _generate_enhanced_alert_analysis(
        self,
        alert_event: dict[str, Any],
        metrics: dict[str, Any] | None,
        docs: list[dict[str, Any]],
        historical_refs: list[dict[str, Any]],
        reference_status: str,
        feedback_info: dict[str, Any] | None,
    ) -> dict[str, Any]:
        context_text = self._build_context_text(docs) if docs else ""
        message = alert_event.get("message", "")
        severity = alert_event.get("severity", "info")

        prompt = f"## 当前告警\n<alert_data>\n消息: {message}\n严重级别: {severity}\n</alert_data>\n"
        if metrics:
            prompt += f"\n## 系统状态\n<metrics_data>\n{str(metrics)[:500]}\n</metrics_data>\n"
        if reference_status == "found":
            prompt += f"\n## 历史相似案例（相同类型）\n{context_text}\n"
        elif reference_status == "type_mismatch":
            prompt += f"\n## 历史参考案例（跨类型）\n{context_text}\n"
        else:
            prompt += "\n## 历史参考\n首次遇到此类告警，无历史参考。\n"
        prompt += "\n请分析当前告警，提供问题摘要、详细分析、处理建议。"

        confidence = self._calculate_confidence(docs)
        if reference_status == "not_found":
            confidence = min(confidence, 0.5)
        elif reference_status == "type_mismatch":
            confidence *= 0.8

        if self._ai:
            try:
                result = await self._ai.analyze("rag", {"prompt": prompt}, "alert_analysis")
                return {
                    "summary": result.get("result", f"告警: {message}")[:500],
                    "details": result.get("result", ""),
                    "recommendations": [],
                    "risk_level": self._map_severity_to_risk(severity),
                    "confidence": confidence,
                }
            except Exception as exc:
                logger.warning("rag_alert_analysis_ai_failed", alert_id=alert_event.get("id", ""), error=str(exc))


    # ------------------------------------------------------------------
    # 增强修复方案生成
    # ------------------------------------------------------------------

    async def generate_remediation(self, analysis: dict[str, Any]) -> dict[str, Any]:
        """增强修复方案生成 — 检索历史修复方案 + LLM 动态生成步骤。

        修复步骤完全由 AI 根据根因描述、历史案例和设备上下文动态生成，
        不硬编码任何特定厂商/平台的命令。
        """
        root_causes = analysis.get("root_causes", [])
        query_text = "根因分析:\n" + "\n".join(
            f"- {rc.get('description', '')} (置信度: {rc.get('confidence', 0)}%)"
            for rc in root_causes
        )

        start = time.time() * 1000
        docs = await self._kb.search(query_text, top_k=self._config.top_k, threshold=self._config.min_score)
        retrieval_time = time.time() * 1000 - start

        historical_plans: list[dict[str, Any]] = []
        for doc in docs:
            success_rate = doc.get("metadata", {}).get("success_rate", 0.5)
            historical_plans.append({
                "plan_id": doc.get("id", ""),
                "similarity": doc.get("score", 0),
                "success_rate": success_rate,
            })

        # 通过 AI 动态生成修复步骤（无硬编码命令）
        steps = await self._ai_generate_remediation_steps(analysis, docs, historical_plans)

        plan = {
            "id": f"plan_{int(time.time() * 1000)}",
            "alert_id": analysis.get("alert_id", ""),
            "timestamp": int(time.time() * 1000),
            "steps": steps,
            "overall_risk": self._calculate_plan_risk(historical_plans),
            "estimated_duration": sum(s.get("estimated_duration", 30) for s in steps),
            "status": "pending",
        }

        self._update_stats(retrieval_time, docs)

        return {
            "plan": plan,
            "rag_context": {
                "query": query_text,
                "retrieved_documents": docs,
                "retrieval_time": retrieval_time,
            },
            "historical_plans": historical_plans,
        }

    async def _ai_generate_remediation_steps(
        self,
        analysis: dict[str, Any],
        docs: list[dict[str, Any]],
        historical_plans: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """通过 AI 动态生成修复步骤 — 设备无关，由 LLM 根据上下文决定具体命令。"""
        root_causes = analysis.get("root_causes", [])
        rc_text = "\n".join(f"- {rc.get('description', '')}" for rc in root_causes)

        # 构建历史案例上下文
        history_context = self._build_context_text(docs) if docs else "无历史修复方案参考。"

        # 高成功率方案提示
        high_success = [p for p in historical_plans if p.get("success_rate", 0) >= 0.8]
        high_success_text = ""
        if high_success:
            high_success_text = "\n推荐参考（高成功率方案）:\n" + "\n".join(
                f"- 方案 {p['plan_id']}: 成功率 {p['success_rate'] * 100:.0f}%"
                for p in high_success
            )

        prompt = (
            f"## 根因分析\n{rc_text}\n\n"
            f"## 影响范围\n{analysis.get('impact', {}).get('scope', '未知')}\n\n"
            f"## 历史修复方案参考\n{history_context}\n"
            f"{high_success_text}\n\n"
            f"请生成修复步骤。注意：\n"
            f"- 根据实际设备类型和平台生成对应的诊断/修复命令\n"
            f"- 不要假设特定厂商，根据根因描述中的线索判断\n"
            f"- 每个步骤包含: description, command, risk_level(low/medium/high), "
            f"auto_executable(bool), estimated_duration(秒)\n"
            f"- 高风险操作(重启/删除/修改关键配置)设 auto_executable=false\n"
            f"- 以 JSON 数组格式返回步骤列表"
        )

        if not self._ai:
            # 无 AI 时返回通用诊断步骤（不含特定命令）
            return [
                {"order": 1, "description": "收集系统状态信息", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 10},
                {"order": 2, "description": "根据根因分析结果执行针对性排查", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 15},
                {"order": 3, "description": "验证修复效果", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 10},
            ]

        try:
            import json as _json
            result = await self._ai.analyze("rag", {"prompt": prompt}, "remediation")
            content = result.get("result", "")
            # 尝试从 AI 响应中解析 JSON 步骤
            json_match = None
            if "[" in content:
                start_idx = content.index("[")
                end_idx = content.rindex("]") + 1
                json_match = content[start_idx:end_idx]
            if json_match:
                raw_steps = _json.loads(json_match)
                steps = []
                for i, s in enumerate(raw_steps, 1):
                    steps.append({
                        "order": i,
                        "description": s.get("description", f"步骤 {i}"),
                        "command": s.get("command", ""),
                        "risk_level": s.get("risk_level", "low"),
                        "auto_executable": s.get("auto_executable", False),
                        "estimated_duration": s.get("estimated_duration", 30),
                    })
                return steps
        except Exception:
            logger.debug("ai_remediation_parse_failed, using generic steps")

        # AI 解析失败时的通用步骤
        return [
            {"order": 1, "description": "收集系统状态信息", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 10},
            {"order": 2, "description": "根据根因分析结果执行针对性排查", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 15},
            {"order": 3, "description": "验证修复效果", "command": "", "risk_level": "low", "auto_executable": False, "estimated_duration": 10},
        ]

    @staticmethod
    def _calculate_plan_risk(historical_plans: list[dict[str, Any]]) -> str:
        if not historical_plans:
            return "medium"
        avg_success = sum(p.get("success_rate", 0.5) for p in historical_plans) / len(historical_plans)
        if avg_success < 0.4:
            return "high"
        if avg_success < 0.7:
            return "medium"
        return "low"


    # ------------------------------------------------------------------
    # 配置变更风险评估
    # ------------------------------------------------------------------

    async def assess_config_risk(self, diff: dict[str, Any]) -> dict[str, Any]:
        """配置变更风险评估 — 检索历史配置变更 + 计算风险评分。"""
        additions = diff.get("additions", [])
        modifications = diff.get("modifications", [])
        deletions = diff.get("deletions", [])

        changes = []
        if additions:
            changes.append(f"新增配置: {', '.join(str(a) for a in additions[:5])}")
        if modifications:
            changes.append(f"修改配置: {', '.join(str(m.get('path', m)) for m in modifications[:5])}")
        if deletions:
            changes.append(f"删除配置: {', '.join(str(d) for d in deletions[:5])}")
        query_text = "配置变更:\n" + "\n".join(changes)

        start = time.time() * 1000
        docs = await self._kb.search(query_text, top_k=self._config.top_k, threshold=self._config.min_score)
        retrieval_time = time.time() * 1000 - start

        # 分析历史结果
        historical_outcomes = self._analyze_historical_outcomes(docs)

        # 计算风险评分
        risk_score = self._calculate_config_risk_score(diff, historical_outcomes)

        # 生成警告和建议
        warnings = self._generate_config_warnings(diff, historical_outcomes)
        suggestions = self._generate_config_suggestions(diff, historical_outcomes)

        self._update_stats(retrieval_time, docs)

        return {
            "risk_score": round(risk_score, 3),
            "historical_outcomes": historical_outcomes,
            "warnings": warnings,
            "suggestions": suggestions,
        }

    @staticmethod
    def _analyze_historical_outcomes(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        outcome_map: dict[str, dict[str, int]] = {}
        for doc in docs:
            content = str(doc.get("content", ""))
            change_type = "general"
            for kw, ct in [("firewall", "firewall"), ("interface", "interface"), ("route", "routing"), ("dns", "dns")]:
                if kw in content.lower():
                    change_type = ct
                    break
            outcome = "unknown"
            if "成功" in content or "success" in content.lower():
                outcome = "success"
            elif "失败" in content or "failed" in content.lower():
                outcome = "failed"
            elif "回滚" in content or "rollback" in content.lower():
                outcome = "rollback"
            outcome_map.setdefault(change_type, {})
            outcome_map[change_type][outcome] = outcome_map[change_type].get(outcome, 0) + 1

        results = []
        for ct, outcomes in outcome_map.items():
            for outcome, count in outcomes.items():
                results.append({"change_type": ct, "outcome": outcome, "count": count})
        return results

    @staticmethod
    def _calculate_config_risk_score(diff: dict[str, Any], outcomes: list[dict[str, Any]]) -> float:
        additions = diff.get("additions", [])
        modifications = diff.get("modifications", [])
        deletions = diff.get("deletions", [])
        total_changes = len(additions) + len(modifications) + len(deletions)

        risk = min(0.3, total_changes * 0.02)
        risk += min(0.2, len(deletions) * 0.05)

        total_hist = sum(o["count"] for o in outcomes)
        if total_hist > 0:
            failed = sum(o["count"] for o in outcomes if o["outcome"] in ("failed", "rollback"))
            risk += (failed / total_hist) * 0.4
        else:
            risk += 0.1

        all_text = " ".join(str(x) for x in additions + deletions + [m.get("new_value", "") for m in modifications]).lower()
        if "firewall" in all_text or "filter" in all_text:
            risk += 0.15
        if "password" in all_text or "secret" in all_text:
            risk += 0.1
        if "route" in all_text or "gateway" in all_text:
            risk += 0.1

        return min(1.0, risk)

    @staticmethod
    def _generate_config_warnings(diff: dict[str, Any], outcomes: list[dict[str, Any]]) -> list[str]:
        warnings = []
        for o in outcomes:
            if o["outcome"] in ("failed", "rollback"):
                warnings.append(f"历史记录显示 {o['change_type']} 类型变更有 {o['count']} 次{o['outcome']}记录")
        deletions = diff.get("deletions", [])
        if len(deletions) > 5:
            warnings.append(f"删除了 {len(deletions)} 项配置，建议先创建备份")
        return warnings

    @staticmethod
    def _generate_config_suggestions(diff: dict[str, Any], outcomes: list[dict[str, Any]]) -> list[str]:
        suggestions = []
        if any(o["outcome"] == "success" for o in outcomes):
            suggestions.append("参考历史成功案例中的配置方式")
        if diff.get("deletions"):
            suggestions.append("建议在删除配置前创建快照备份")
        if len(diff.get("modifications", [])) > 3:
            suggestions.append("建议分批执行修改，每批后验证系统状态")
        if not suggestions:
            suggestions.append("建议在生产环境应用前进行测试")
        return suggestions


    # ------------------------------------------------------------------
    # 增强根因分析 (带并发控制)
    # ------------------------------------------------------------------

    async def analyze_root_cause(self, event: dict[str, Any]) -> dict[str, Any]:
        """增强根因分析 — 缓存 + 并发控制 + RAG 检索。"""
        event_id = event.get("id", "")

        # 缓存检查
        cached = self._get_cached(self._root_cause_cache, event_id, self._root_cause_cache_stats)
        if cached:
            return cached

        # 通过并发控制器执行
        if self._rag_controller:
            severity_priority = {"critical": 1, "high": 2, "medium": 3, "low": 4, "info": 5}
            priority = severity_priority.get(event.get("severity", "medium"), 3)
            try:
                return await self._rag_controller.enqueue(event, priority)
            except RuntimeError as exc:
                if "Backpressure" in str(exc) or "Queue full" in str(exc):
                    logger.warning("rag_analysis_degraded", event_id=event_id, reason=str(exc))
                    return self._create_degraded_rca(event, "系统负载过高，使用简化分析")
                raise

        return await self._execute_root_cause_analysis(event)

    async def _execute_root_cause_analysis(self, event: dict[str, Any]) -> dict[str, Any]:
        """实际的根因分析逻辑 (被并发控制器调用)。"""
        event_id = event.get("id", "")
        message = event.get("message", "")
        category = event.get("category", "unknown")

        start = time.time() * 1000
        query_text = f"分类: {category} 消息: {message}"

        docs = await self._kb.search(query_text, top_k=self._config.top_k, threshold=self._config.min_score)
        retrieval_time = time.time() * 1000 - start

        # 构建根因
        root_causes = [{
            "id": f"rc_{int(time.time() * 1000)}",
            "description": f"{category} 相关问题: {message}",
            "confidence": 60 if docs else 30,
            "evidence": [f"基于 {len(docs)} 个历史案例分析"] if docs else ["基于事件信息推断"],
        }]

        # 如果有 AI 分析器，尝试更深入的分析
        if self._ai and docs:
            context_text = self._build_context_text(docs)
            try:
                ai_result = await self._ai.analyze(
                    "rag",
                    {"prompt": f"根因分析:\n事件: {message}\n\n历史案例:\n{context_text}\n\n请分析根本原因。"},
                    "root_cause",
                )
                if ai_result.get("result"):
                    root_causes[0]["description"] = str(ai_result["result"])[:500]
                    root_causes[0]["confidence"] = 75
            except Exception as exc:
                logger.warning("rag_root_cause_ai_failed", event_id=event_id, error=str(exc))
            {"id": d.get("id", ""), "similarity": d.get("score", 0)}
            for d in docs
        ]

        result: dict[str, Any] = {
            "id": f"rca_{int(time.time() * 1000)}",
            "alert_id": event_id,
            "timestamp": int(time.time() * 1000),
            "root_causes": root_causes,
            "timeline": {
                "events": [{"timestamp": event.get("timestamp", 0), "event_id": event_id, "description": message}],
            },
            "impact": {"scope": "local", "affected_resources": []},
            "similar_incidents": similar_incidents,
        }

        self._update_stats(retrieval_time, docs)
        self._set_cached(self._root_cause_cache, event_id, result)
        return result

    @staticmethod
    def _create_degraded_rca(event: dict[str, Any], reason: str) -> dict[str, Any]:
        return {
            "id": f"rca_degraded_{int(time.time() * 1000)}",
            "alert_id": event.get("id", ""),
            "timestamp": int(time.time() * 1000),
            "root_causes": [{
                "id": f"rc_degraded_{int(time.time() * 1000)}",
                "description": f"{event.get('category', 'unknown')} 相关问题: {event.get('message', '')} ({reason})",
                "confidence": 10,
                "evidence": ["降级模式"],
            }],
            "timeline": {"events": []},
            "impact": {"scope": "local", "affected_resources": []},
            "similar_incidents": [],
        }
