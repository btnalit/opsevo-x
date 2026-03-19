"""AlertEngine — alert rule evaluation, event management, syslog processing.

Requirements: 9.1, 1.6
Severity mapping loaded from DeviceDriver Profile, no hardcoded RouterOS mappings.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from opsevo.data.datastore import DataStore
from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class AlertEngineConfig:
    cooldown_ms: int = 300_000
    max_active_alerts: int = 1000
    persist_interval_ms: int = 30_000
    cache_cleanup_interval_ms: int = 60_000


@dataclass
class AlertRule:
    id: str = ""
    name: str = ""
    metric: str = ""
    operator: str = ">"
    threshold: float = 0
    severity: str = "warning"
    enabled: bool = True
    cooldown_ms: int = 300_000
    device_id: str | None = None
    auto_response: str | None = None
    created_at: int = 0
    updated_at: int = 0


@dataclass
class AlertEvent:
    id: str = ""
    rule_id: str = ""
    device_id: str = ""
    severity: str = "warning"
    message: str = ""
    state: str = "active"  # active, acknowledged, resolved, closed
    current_value: float = 0
    threshold: float = 0
    timestamp: int = 0
    resolved_at: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class AlertEngine:
    def __init__(self, datastore: DataStore, event_bus: EventBus, config: AlertEngineConfig | None = None):
        self._ds = datastore
        self._event_bus = event_bus
        self._config = config or AlertEngineConfig()
        self._rules: dict[str, AlertRule] = {}
        self._active_alerts: dict[str, AlertEvent] = {}
        self._trigger_states: dict[str, dict[str, Any]] = {}
        self._severity_map: dict[str, str] = {}
        self._preprocessed_handlers: list[Callable] = []
        self._initialized = False

    def set_severity_map(self, mappings: dict[str, list[str]]) -> None:
        """Load severity mapping from Profile config, NOT hardcoded."""
        self._severity_map = {}
        for severity, topics in mappings.items():
            for topic in topics:
                self._severity_map[topic.lower()] = severity

    async def initialize(self) -> None:
        await self._load_rules()
        await self._load_active_alerts()
        self._initialized = True
        logger.info("alert_engine_initialized", rules=len(self._rules), active=len(self._active_alerts))

    async def _load_rules(self) -> None:
        try:
            rows = await self._ds.query("SELECT * FROM alert_rules ORDER BY created_at")
            for row in rows:
                rule = AlertRule(
                    id=row["id"], name=row.get("name", ""), metric=row.get("metric", ""),
                    operator=row.get("operator", ">"), threshold=row.get("threshold", 0),
                    severity=row.get("severity", "warning"), enabled=row.get("enabled", True),
                    cooldown_ms=row.get("cooldown_ms", 300000),
                    device_id=row.get("device_id"), auto_response=row.get("auto_response"),
                    created_at=row.get("created_at", 0), updated_at=row.get("updated_at", 0),
                )
                self._rules[rule.id] = rule
        except Exception:
            logger.warning("alert_rules_load_failed_using_empty")

    async def _load_active_alerts(self) -> None:
        try:
            rows = await self._ds.query(
                "SELECT * FROM alert_events WHERE state IN ('active','acknowledged') ORDER BY timestamp DESC LIMIT $1",
                (self._config.max_active_alerts,),
            )
            for row in rows:
                evt = AlertEvent(
                    id=row["id"], rule_id=row.get("rule_id", ""), device_id=row.get("device_id", ""),
                    severity=row.get("severity", "warning"), message=row.get("message", ""),
                    state=row.get("state", "active"), current_value=row.get("current_value", 0),
                    threshold=row.get("threshold", 0), timestamp=row.get("timestamp", 0),
                    metadata=row.get("metadata", {}),
                )
                self._active_alerts[evt.id] = evt
        except Exception:
            logger.warning("active_alerts_load_failed")

    # ------------------------------------------------------------------
    # Rule CRUD
    # ------------------------------------------------------------------

    async def create_rule(self, data: dict[str, Any]) -> AlertRule:
        now = int(time.time() * 1000)
        rule = AlertRule(
            id=str(uuid.uuid4()), name=data.get("name", ""),
            metric=data.get("metric", ""), operator=data.get("operator", ">"),
            threshold=data.get("threshold", 0), severity=data.get("severity", "warning"),
            enabled=data.get("enabled", True), cooldown_ms=data.get("cooldown_ms", 300000),
            device_id=data.get("device_id"), auto_response=data.get("auto_response"),
            created_at=now, updated_at=now,
        )
        await self._ds.execute(
            "INSERT INTO alert_rules (id,name,metric,operator,threshold,severity,enabled,cooldown_ms,device_id,auto_response,created_at,updated_at) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            (rule.id, rule.name, rule.metric, rule.operator, rule.threshold,
             rule.severity, rule.enabled, rule.cooldown_ms, rule.device_id,
             rule.auto_response, rule.created_at, rule.updated_at),
        )
        self._rules[rule.id] = rule
        return rule

    async def update_rule(self, rule_id: str, updates: dict[str, Any]) -> AlertRule:
        rule = self._rules.get(rule_id)
        if not rule:
            raise ValueError(f"Rule {rule_id} not found")
        for k, v in updates.items():
            if hasattr(rule, k):
                setattr(rule, k, v)
        rule.updated_at = int(time.time() * 1000)
        await self._ds.execute(
            "UPDATE alert_rules SET name=$1,metric=$2,operator=$3,threshold=$4,severity=$5,"
            "enabled=$6,cooldown_ms=$7,auto_response=$8,updated_at=$9 WHERE id=$10",
            (rule.name, rule.metric, rule.operator, rule.threshold, rule.severity,
             rule.enabled, rule.cooldown_ms, rule.auto_response, rule.updated_at, rule.id),
        )
        return rule

    async def delete_rule(self, rule_id: str) -> None:
        self._rules.pop(rule_id, None)
        await self._ds.execute("DELETE FROM alert_rules WHERE id = $1", (rule_id,))

    async def get_rules(self, device_id: str | None = None) -> list[AlertRule]:
        rules = list(self._rules.values())
        if device_id:
            rules = [r for r in rules if r.device_id == device_id or r.device_id is None]
        return rules

    async def get_rule_by_id(self, rule_id: str) -> AlertRule | None:
        return self._rules.get(rule_id)

    # ------------------------------------------------------------------
    # Alert evaluation
    # ------------------------------------------------------------------

    @staticmethod
    def evaluate_condition(value: float, operator: str, threshold: float) -> bool:
        ops = {">": value > threshold, ">=": value >= threshold, "<": value < threshold,
               "<=": value <= threshold, "==": value == threshold, "!=": value != threshold}
        return ops.get(operator, False)

    async def evaluate(self, device_id: str, metrics: dict[str, Any]) -> list[AlertEvent]:
        triggered: list[AlertEvent] = []
        rules = await self.get_rules(device_id)
        for rule in rules:
            if not rule.enabled:
                continue
            value = self._get_metric_value(metrics, rule.metric)
            if value is None:
                continue
            if self._is_in_cooldown(rule.id):
                continue
            if self.evaluate_condition(value, rule.operator, rule.threshold):
                evt = await self._create_alert_event(rule, device_id, value)
                triggered.append(evt)
        return triggered

    def _get_metric_value(self, metrics: dict[str, Any], metric_path: str) -> float | None:
        parts = metric_path.split(".")
        current: Any = metrics
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            else:
                return None
        try:
            return float(current)
        except (TypeError, ValueError):
            return None

    def _is_in_cooldown(self, rule_id: str) -> bool:
        state = self._trigger_states.get(rule_id)
        if not state:
            return False
        last = state.get("last_triggered", 0)
        cooldown = self._rules.get(rule_id, AlertRule()).cooldown_ms
        return (int(time.time() * 1000) - last) < cooldown

    async def _create_alert_event(self, rule: AlertRule, device_id: str, value: float) -> AlertEvent:
        now = int(time.time() * 1000)
        evt = AlertEvent(
            id=str(uuid.uuid4()), rule_id=rule.id, device_id=device_id,
            severity=rule.severity, message=f"{rule.name}: {rule.metric} {rule.operator} {rule.threshold} (current: {value})",
            state="active", current_value=value, threshold=rule.threshold, timestamp=now,
        )
        self._active_alerts[evt.id] = evt
        self._trigger_states[rule.id] = {"last_triggered": now}
        await self._ds.execute(
            "INSERT INTO alert_events (id,rule_id,device_id,severity,message,state,current_value,threshold,timestamp) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            (evt.id, evt.rule_id, evt.device_id, evt.severity, evt.message,
             evt.state, evt.current_value, evt.threshold, evt.timestamp),
        )
        await self._event_bus.publish(PerceptionEvent(
            type=EventType.ALERT, priority=Priority.HIGH,
            source="alert_engine",
            payload={"alert_id": evt.id, "rule_id": rule.id, "device_id": device_id, "severity": rule.severity},
            schema_version="1.0",
        ))
        return evt

    # ------------------------------------------------------------------
    # Alert state management
    # ------------------------------------------------------------------

    async def get_active_alerts(self, device_id: str | None = None) -> list[AlertEvent]:
        alerts = list(self._active_alerts.values())
        if device_id:
            alerts = [a for a in alerts if a.device_id == device_id]
        return sorted(alerts, key=lambda a: a.timestamp, reverse=True)

    async def resolve_alert(self, alert_id: str) -> None:
        evt = self._active_alerts.pop(alert_id, None)
        if evt:
            evt.state = "resolved"
            evt.resolved_at = int(time.time() * 1000)
        await self._ds.execute(
            "UPDATE alert_events SET state='resolved', resolved_at=$1 WHERE id=$2",
            (int(time.time() * 1000), alert_id),
        )

    async def get_alert_history(self, from_ts: int, to_ts: int, device_id: str | None = None) -> list[dict[str, Any]]:
        if device_id:
            return await self._ds.query(
                "SELECT * FROM alert_events WHERE timestamp >= $1 AND timestamp <= $2 AND device_id = $3 ORDER BY timestamp DESC",
                (from_ts, to_ts, device_id),
            )
        return await self._ds.query(
            "SELECT * FROM alert_events WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC",
            (from_ts, to_ts),
        )

    async def query_alert_history(
        self,
        from_ts: int,
        to_ts: int,
        device_id: str | None = None,
        severity: str | None = None,
        status: str | None = None,
        source: str | None = None,
        page: int = 1,
        limit: int = 50,
    ) -> dict[str, Any]:
        """带 SQL 级过滤和分页的告警历史查询。"""
        where = ["timestamp >= $1", "timestamp <= $2"]
        params: list[Any] = [from_ts, to_ts]
        idx = 3

        if device_id:
            where.append(f"device_id = ${idx}")
            params.append(device_id)
            idx += 1
        if severity:
            where.append(f"severity = ${idx}")
            params.append(severity)
            idx += 1
        if status:
            where.append(f"state = ${idx}")
            params.append(status)
            idx += 1
        if source and source != "all":
            where.append(f"COALESCE(source, 'metrics') = ${idx}")
            params.append(source)
            idx += 1

        where_clause = " AND ".join(where)
        count_row = await self._ds.query_one(
            f"SELECT COUNT(*) AS total FROM alert_events WHERE {where_clause}",
            params,
        )
        total = count_row["total"] if count_row else 0

        offset = (page - 1) * limit
        rows = await self._ds.query(
            f"SELECT * FROM alert_events WHERE {where_clause} ORDER BY timestamp DESC LIMIT {int(limit)} OFFSET {int(offset)}",
            params,
        )
        return {"data": rows, "total": total}

    async def delete_alert_event(self, alert_id: str) -> None:
        self._active_alerts.pop(alert_id, None)
        await self._ds.execute("DELETE FROM alert_events WHERE id = $1", (alert_id,))

    async def transition_alert_state(self, alert_id: str, new_state: str) -> AlertEvent | None:
        evt = self._active_alerts.get(alert_id)
        if not evt:
            row = await self._ds.query_one("SELECT * FROM alert_events WHERE id = $1", (alert_id,))
            if not row:
                return None
            evt = AlertEvent(id=row["id"], state=row.get("state", "active"))
        evt.state = new_state
        if new_state in ("resolved", "closed"):
            evt.resolved_at = int(time.time() * 1000)
            self._active_alerts.pop(alert_id, None)
        await self._ds.execute("UPDATE alert_events SET state=$1 WHERE id=$2", (new_state, alert_id))
        return evt

    def map_severity(self, topic: str) -> str:
        """Map topic to severity using Profile-loaded mapping (device-agnostic)."""
        return self._severity_map.get(topic.lower(), "info")

    async def process_syslog_event(self, syslog_event: dict[str, Any]) -> None:
        fp = self._generate_syslog_fingerprint(syslog_event)
        severity = self.map_severity(syslog_event.get("topic", ""))
        evt = AlertEvent(
            id=str(uuid.uuid4()), device_id=syslog_event.get("device_id", ""),
            severity=severity, message=syslog_event.get("message", ""),
            state="active", timestamp=int(time.time() * 1000),
            metadata={"source": "syslog", "fingerprint": fp},
        )
        self._active_alerts[evt.id] = evt
        for handler in self._preprocessed_handlers:
            try:
                handler(evt)
            except Exception:
                pass

    @staticmethod
    def _generate_syslog_fingerprint(event: dict[str, Any]) -> str:
        key = f"{event.get('device_id','')}-{event.get('topic','')}-{event.get('message','')[:100]}"
        return hashlib.md5(key.encode()).hexdigest()

    def on_preprocessed_event(self, handler: Callable) -> None:
        self._preprocessed_handlers.append(handler)

    async def flush(self) -> None:
        logger.info("alert_engine_flushed")

    async def stop(self) -> None:
        await self.flush()
        logger.info("alert_engine_stopped")

    async def health_check(self) -> dict[str, Any]:
        return {"healthy": self._initialized, "rules": len(self._rules), "active_alerts": len(self._active_alerts)}
