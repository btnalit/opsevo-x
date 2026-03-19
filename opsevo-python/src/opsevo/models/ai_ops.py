"""AI-Ops Pydantic models.

Requirements: 2.3, 3.2, 9.1, 9.2
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ── Alert Rules ───────────────────────────────────────────────────────────

class AlertRuleCreate(BaseModel):
    name: str
    condition: str
    severity: str = "warning"
    device_id: str | None = Field(default=None, alias="deviceId")
    enabled: bool = True
    description: str = ""

    model_config = {"populate_by_name": True}


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    condition: str | None = None
    severity: str | None = None
    enabled: bool | None = None
    description: str | None = None


class AlertRule(BaseModel):
    id: str
    name: str
    condition: str
    severity: str
    device_id: str | None = Field(default=None, alias="deviceId")
    enabled: bool = True
    description: str = ""
    created_at: str = Field(default="", alias="createdAt")
    updated_at: str = Field(default="", alias="updatedAt")

    model_config = {"populate_by_name": True}


# ── Alert Events ──────────────────────────────────────────────────────────

class AlertEvent(BaseModel):
    id: str
    rule_id: str = Field(default="", alias="ruleId")
    device_id: str = Field(default="", alias="deviceId")
    severity: str = "warning"
    message: str = ""
    source: str = ""
    status: str = "active"  # active | resolved | acknowledged
    resolved_at: str | None = Field(default=None, alias="resolvedAt")
    created_at: str = Field(default="", alias="createdAt")
    metadata: dict = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


# ── Scheduled Tasks ──────────────────────────────────────────────────────

class ScheduledTaskCreate(BaseModel):
    name: str
    type: str
    cron_expression: str | None = Field(default=None, alias="cronExpression")
    interval_ms: int | None = Field(default=None, alias="intervalMs")
    config: dict = Field(default_factory=dict)
    device_id: str | None = Field(default=None, alias="deviceId")
    enabled: bool = True

    model_config = {"populate_by_name": True}


class ScheduledTaskUpdate(BaseModel):
    name: str | None = None
    cron_expression: str | None = Field(default=None, alias="cronExpression")
    interval_ms: int | None = Field(default=None, alias="intervalMs")
    config: dict | None = None
    enabled: bool | None = None

    model_config = {"populate_by_name": True}


class ScheduledTask(BaseModel):
    id: str
    name: str
    type: str
    cron_expression: str | None = Field(default=None, alias="cronExpression")
    interval_ms: int | None = Field(default=None, alias="intervalMs")
    config: dict = Field(default_factory=dict)
    device_id: str | None = Field(default=None, alias="deviceId")
    enabled: bool = True
    last_run: str | None = Field(default=None, alias="lastRun")
    next_run: str | None = Field(default=None, alias="nextRun")

    model_config = {"populate_by_name": True}


# ── Remediation ───────────────────────────────────────────────────────────

class RemediationStep(BaseModel):
    order: int = 0
    action: str = ""
    description: str = ""
    risk_level: str = Field(default="low", alias="riskLevel")
    rollback_action: str = Field(default="", alias="rollbackAction")

    model_config = {"populate_by_name": True}


class RemediationPlan(BaseModel):
    id: str
    alert_id: str = Field(default="", alias="alertId")
    device_id: str = Field(default="", alias="deviceId")
    steps: list[RemediationStep] = Field(default_factory=list)
    risk_level: str = Field(default="low", alias="riskLevel")
    auto_execute: bool = Field(default=False, alias="autoExecute")
    status: str = "pending"  # pending | executing | completed | failed | rolled_back
    created_at: str = Field(default="", alias="createdAt")

    model_config = {"populate_by_name": True}


# ── Health Report ─────────────────────────────────────────────────────────

class HealthReport(BaseModel):
    device_id: str = Field(default="", alias="deviceId")
    timestamp: float = 0.0
    overall_score: float = Field(default=0.0, alias="overallScore")
    metrics: dict = Field(default_factory=dict)
    alerts: list[dict] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    issues: list[dict] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


# ── Snapshots ─────────────────────────────────────────────────────────────

class SnapshotResponse(BaseModel):
    id: str
    device_id: str = Field(default="", alias="deviceId")
    description: str = ""
    created_at: str = Field(default="", alias="createdAt")
    size: int = 0
    sections: list[str] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


# ── Notifications ─────────────────────────────────────────────────────────

class NotificationChannelCreate(BaseModel):
    name: str
    type: str  # email | webhook | telegram | slack
    config: dict = Field(default_factory=dict)
    enabled: bool = True


class NotificationChannel(BaseModel):
    id: str
    name: str
    type: str
    config: dict = Field(default_factory=dict)
    enabled: bool = True
    created_at: str = Field(default="", alias="createdAt")

    model_config = {"populate_by_name": True}


# ── Fault Patterns ────────────────────────────────────────────────────────

class FaultPatternCreate(BaseModel):
    name: str
    pattern: str
    severity: str = "warning"
    auto_heal: bool = Field(default=False, alias="autoHeal")
    remediation_template: str = Field(default="", alias="remediationTemplate")

    model_config = {"populate_by_name": True}


class FaultPattern(BaseModel):
    id: str
    name: str
    pattern: str
    severity: str = "warning"
    auto_heal: bool = Field(default=False, alias="autoHeal")
    remediation_template: str = Field(default="", alias="remediationTemplate")
    match_count: int = Field(default=0, alias="matchCount")
    last_matched: str | None = Field(default=None, alias="lastMatched")

    model_config = {"populate_by_name": True}


# ── Metrics ───────────────────────────────────────────────────────────────

class MetricsConfigUpdate(BaseModel):
    collection_interval: int | None = Field(default=None, alias="collectionInterval")
    retention_days: int | None = Field(default=None, alias="retentionDays")
    enabled_metrics: list[str] | None = Field(default=None, alias="enabledMetrics")

    model_config = {"populate_by_name": True}


# ── Decision Rules ────────────────────────────────────────────────────────

class DecisionRuleCreate(BaseModel):
    name: str
    condition: str
    action: str
    priority: int = 0
    enabled: bool = True


class DecisionRule(BaseModel):
    id: str
    name: str
    condition: str
    action: str
    priority: int = 0
    enabled: bool = True
    created_at: str = Field(default="", alias="createdAt")

    model_config = {"populate_by_name": True}


# ── Feedback ──────────────────────────────────────────────────────────────

class FeedbackSubmit(BaseModel):
    alert_id: str = Field(alias="alertId")
    rating: int  # 1-5
    comment: str = ""
    useful: bool = True

    model_config = {"populate_by_name": True}


class FeedbackStats(BaseModel):
    total: int = 0
    average_rating: float = Field(default=0.0, alias="averageRating")
    positive_count: int = Field(default=0, alias="positiveCount")
    negative_count: int = Field(default=0, alias="negativeCount")

    model_config = {"populate_by_name": True}


# ── Syslog ────────────────────────────────────────────────────────────────

class SyslogConfigUpdate(BaseModel):
    enabled: bool | None = None
    port: int | None = None
    filters: list[dict] | None = None


class SyslogStatus(BaseModel):
    running: bool = False
    port: int = 514
    events_received: int = Field(default=0, alias="eventsReceived")
    events_processed: int = Field(default=0, alias="eventsProcessed")

    model_config = {"populate_by_name": True}


# ── Evolution ─────────────────────────────────────────────────────────────

class EvolutionConfigUpdate(BaseModel):
    """Partial update for evolution configuration."""
    data: dict = Field(default_factory=dict)


class EvolutionStatus(BaseModel):
    enabled: bool = False
    capabilities: dict = Field(default_factory=dict)
    last_evolution: str | None = Field(default=None, alias="lastEvolution")

    model_config = {"populate_by_name": True}
