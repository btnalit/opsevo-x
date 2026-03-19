-- ============================================================
-- Migration 001: Python 后端数据库 Schema 对齐
-- 生成日期: 2026-03-19
-- 目的: 修复 ARCHITECTURE.md 审计发现的所有数据库问题
--   1. 为 Node.js 已有表补充 Python 需要的列
--   2. 创建 Python 引用但无 DDL 的 42 张表
--   3. 为表名不一致的 3 组表创建独立实表
--   4. 修复 known_issues 的 title/name 不一致
-- ============================================================

-- ============================================================
-- Part A: ALTER 已有表，补充 Python 需要的列
-- ============================================================

-- A1. users: 补充 email, tenant_id
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100);

-- A2. devices: 补充 tenant_id
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100);

-- A3. chat_sessions: 补充 mode, type
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS mode VARCHAR(50);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(50);

-- A4. chat_messages: 补充 collected (Python 用此列名，Node.js 用 is_favorited)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS collected BOOLEAN DEFAULT false;

-- A5. alert_rules: 补充 Python 使用的列
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS metric VARCHAR(255);
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS operator VARCHAR(10);
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS threshold REAL;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS cooldown_ms INTEGER;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id);
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS auto_response TEXT;

-- A6. alert_events: 补充 Python 使用的列
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS state VARCHAR(20);
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS current_value REAL;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS threshold REAL;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS timestamp BIGINT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- A7. prompt_templates: 补充 Python 使用的列
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS device_id UUID;
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS placeholders JSONB;
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- A8. config_snapshots: 补充 name 列
ALTER TABLE config_snapshots ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- A9. audit_logs: 补充 device_id 列
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS device_id UUID;

-- A10. notification_channels (002 已有): 补充 device_id
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS device_id UUID;

-- A10b. notifications (002 已有): 补充 device_id
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS device_id UUID;

-- A11. decision_rules (002 已有): 补充 Python 使用的列
ALTER TABLE decision_rules ADD COLUMN IF NOT EXISTS device_id UUID;
ALTER TABLE decision_rules ADD COLUMN IF NOT EXISTS weights JSONB;
ALTER TABLE decision_rules ADD COLUMN IF NOT EXISTS description TEXT;

-- A12. snmp_v3_credentials (002 已有): 补充 Python ai_ops.py 使用的列
ALTER TABLE snmp_v3_credentials ADD COLUMN IF NOT EXISTS auth_password TEXT;
ALTER TABLE snmp_v3_credentials ADD COLUMN IF NOT EXISTS priv_password TEXT;

-- A13. evaluation_reports (002 已有): 补充 plan_id
ALTER TABLE evaluation_reports ADD COLUMN IF NOT EXISTS plan_id VARCHAR(255);

-- A14. learning_records (002 已有): 补充 Python 使用的列
ALTER TABLE learning_records ADD COLUMN IF NOT EXISTS type VARCHAR(100);
ALTER TABLE learning_records ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE learning_records ADD COLUMN IF NOT EXISTS result VARCHAR(100);

-- A15. decision_history (002 已有): 补充 Python 使用的列
ALTER TABLE decision_history ADD COLUMN IF NOT EXISTS device_id UUID;
ALTER TABLE decision_history ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ;

-- A16. ai_configs (001 已有): 补充 Python 使用的列
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS model_name VARCHAR(255);
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS base_url VARCHAR(500);
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- A17. feature_flags (003 已有): 补充 Python 使用的 key/value 列
-- Node.js DDL 用 flag_key/enabled，Python 代码用 key/value + ON CONFLICT (key)
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS key VARCHAR(255);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS value VARCHAR(50);
-- 创建 UNIQUE 约束以支持 ON CONFLICT (key)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_flags_key_unique') THEN
        ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_key_unique UNIQUE (key);
    END IF;
END $$;


-- ============================================================
-- Part B: 创建 Python 引用但无 DDL 的表
-- ============================================================

-- B1. device_settings (ai_ops.py — 设备级配置 KV 存储)
CREATE TABLE IF NOT EXISTS device_settings (
    device_id UUID NOT NULL,
    key       VARCHAR(100) NOT NULL,
    config    JSONB,
    UNIQUE (device_id, key)
);

-- B2. reports (ai_ops.py — 健康/分析报告)
CREATE TABLE IF NOT EXISTS reports (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    type       VARCHAR(100),
    content    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_device ON reports(device_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- B3. fault_patterns (ai_ops.py — 故障模式)
CREATE TABLE IF NOT EXISTS fault_patterns (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    name        VARCHAR(255),
    pattern     JSONB,
    severity    VARCHAR(20) DEFAULT 'warning',
    auto_heal   BOOLEAN DEFAULT false,
    description TEXT,
    enabled     BOOLEAN DEFAULT true,
    status      VARCHAR(50),
    confidence  REAL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fault_patterns_device ON fault_patterns(device_id);

-- B4. fault_pattern_cases (ai_ops.py — 故障模式匹配案例)
CREATE TABLE IF NOT EXISTS fault_pattern_cases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_id UUID REFERENCES fault_patterns(id),
    event_id   UUID,
    matched_at TIMESTAMPTZ,
    similarity REAL
);
CREATE INDEX IF NOT EXISTS idx_fault_pattern_cases_pattern ON fault_pattern_cases(pattern_id);

-- B5. remediation_executions (ai_ops.py + fault_healer.py)
-- 注意: ai_ops.py 查询 device_id, pattern_name, action, result
--       fault_healer.py INSERT alert_id, script, success, output, timestamp
CREATE TABLE IF NOT EXISTS remediation_executions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id     UUID,
    device_id    UUID,
    pattern_name VARCHAR(255),
    action       VARCHAR(255),
    script       TEXT,
    success      BOOLEAN,
    output       TEXT,
    result       JSONB,
    timestamp    BIGINT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remediation_device ON remediation_executions(device_id);
CREATE INDEX IF NOT EXISTS idx_remediation_timestamp ON remediation_executions(timestamp DESC);

-- B6. maintenance_windows (ai_ops.py)
CREATE TABLE IF NOT EXISTS maintenance_windows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    name        VARCHAR(255),
    start_time  BIGINT,
    end_time    BIGINT,
    filters     JSONB,
    enabled     BOOLEAN DEFAULT true,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_device ON maintenance_windows(device_id);

-- B7. known_issues (ai_ops.py)
-- 注意: INSERT 用 title, _ALLOWED 用 name → 两列都创建
CREATE TABLE IF NOT EXISTS known_issues (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    UUID,
    title        VARCHAR(255),
    name         VARCHAR(255),
    description  TEXT,
    pattern      JSONB,
    auto_resolve BOOLEAN DEFAULT false,
    severity     VARCHAR(20),
    enabled      BOOLEAN DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_known_issues_device ON known_issues(device_id);

-- B8. feedback (ai_ops.py — 用户反馈)
CREATE TABLE IF NOT EXISTS feedback (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    UUID,
    alert_id     UUID,
    analysis_id  UUID,
    rating       INTEGER,
    comment      TEXT,
    action_taken VARCHAR(255),
    rule_id      UUID,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedback(device_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rule ON feedback(rule_id);

-- B9. alert_analyses (ai_ops.py)
CREATE TABLE IF NOT EXISTS alert_analyses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id   UUID,
    device_id  UUID,
    analysis   JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_analyses_alert ON alert_analyses(alert_id);

-- B10. alert_timeline (ai_ops.py)
CREATE TABLE IF NOT EXISTS alert_timeline (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id   UUID,
    event_type VARCHAR(100),
    details    JSONB,
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_timeline_alert ON alert_timeline(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_timeline_ts ON alert_timeline(timestamp DESC);

-- B11. scheduler_executions (ai_ops.py)
CREATE TABLE IF NOT EXISTS scheduler_executions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    task_id    UUID,
    status     VARCHAR(50),
    output     TEXT,
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduler_exec_device ON scheduler_executions(device_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_exec_ts ON scheduler_executions(timestamp DESC);


-- B12. system_metrics (ai_ops.py — 系统指标时序)
CREATE TABLE IF NOT EXISTS system_metrics (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    cpu_usage  REAL,
    memory_usage REAL,
    disk_usage REAL,
    uptime     BIGINT,
    metadata   JSONB DEFAULT '{}',
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_metrics_device ON system_metrics(device_id);
CREATE INDEX IF NOT EXISTS idx_system_metrics_ts ON system_metrics(timestamp DESC);

-- B13. traffic_metrics (ai_ops.py — 流量指标时序)
CREATE TABLE IF NOT EXISTS traffic_metrics (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    interface  VARCHAR(255),
    rx_rate    REAL,
    tx_rate    REAL,
    rx_bytes   BIGINT,
    tx_bytes   BIGINT,
    metadata   JSONB DEFAULT '{}',
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_traffic_metrics_device ON traffic_metrics(device_id);
CREATE INDEX IF NOT EXISTS idx_traffic_metrics_iface ON traffic_metrics(device_id, interface);
CREATE INDEX IF NOT EXISTS idx_traffic_metrics_ts ON traffic_metrics(timestamp DESC);

-- B14. health_checks (ai_ops.py — 健康检查记录)
CREATE TABLE IF NOT EXISTS health_checks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    status     VARCHAR(50),
    score      REAL,
    details    JSONB DEFAULT '{}',
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_checks_device ON health_checks(device_id);
CREATE INDEX IF NOT EXISTS idx_health_checks_ts ON health_checks(timestamp DESC);

-- B15. syslog_events (ai_ops.py — Syslog 事件)
CREATE TABLE IF NOT EXISTS syslog_events (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    severity   VARCHAR(20),
    facility   VARCHAR(50),
    message    TEXT,
    source_ip  VARCHAR(45),
    metadata   JSONB DEFAULT '{}',
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_syslog_events_device ON syslog_events(device_id);
CREATE INDEX IF NOT EXISTS idx_syslog_events_severity ON syslog_events(severity);
CREATE INDEX IF NOT EXISTS idx_syslog_events_ts ON syslog_events(timestamp DESC);

-- B16. syslog_sources (ai_ops.py — Syslog 来源配置)
CREATE TABLE IF NOT EXISTS syslog_sources (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255),
    host        VARCHAR(255),
    port        INTEGER DEFAULT 514,
    protocol    VARCHAR(10) DEFAULT 'udp',
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- B17. syslog_rules (ai_ops.py — Syslog 解析规则)
CREATE TABLE IF NOT EXISTS syslog_rules (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(255),
    pattern    TEXT,
    action     JSONB,
    priority   INTEGER DEFAULT 0,
    enabled    BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B18. syslog_filters (ai_ops.py — Syslog 过滤规则)
CREATE TABLE IF NOT EXISTS syslog_filters (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(255),
    condition  JSONB,
    action     VARCHAR(50) DEFAULT 'drop',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B19. snmp_oid_mappings (ai_ops.py — SNMP OID 映射)
CREATE TABLE IF NOT EXISTS snmp_oid_mappings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oid         VARCHAR(255),
    name        VARCHAR(255),
    severity    VARCHAR(20) DEFAULT 'info',
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- B20. iterations (ai_ops.py — 进化迭代)
CREATE TABLE IF NOT EXISTS iterations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    status     VARCHAR(50) DEFAULT 'pending',
    config     JSONB DEFAULT '{}',
    result     JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ,
    ended_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_iterations_device ON iterations(device_id);
CREATE INDEX IF NOT EXISTS idx_iterations_status ON iterations(status);

-- B21. learning_entries (ai_ops.py — 学习条目)
CREATE TABLE IF NOT EXISTS learning_entries (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    category   VARCHAR(100),
    content    JSONB DEFAULT '{}',
    source     VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_learning_entries_device ON learning_entries(device_id);
CREATE INDEX IF NOT EXISTS idx_learning_entries_category ON learning_entries(category);

-- B22. critic_evaluations (ai_ops.py — Critic 评估)
CREATE TABLE IF NOT EXISTS critic_evaluations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    tick_id    VARCHAR(100),
    result     VARCHAR(50),
    score      REAL,
    details    JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_critic_eval_device ON critic_evaluations(device_id);

-- B23. reflector_suggestions (ai_ops.py — Reflector 建议)
CREATE TABLE IF NOT EXISTS reflector_suggestions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    tick_id    VARCHAR(100),
    suggestion TEXT,
    applied    BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reflector_device ON reflector_suggestions(device_id);

-- B24. tool_usage (ai_ops.py — 工具使用统计)
CREATE TABLE IF NOT EXISTS tool_usage (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    tool_name   VARCHAR(255),
    duration_ms REAL,
    success     BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_device ON tool_usage(device_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);

-- B25. anomaly_predictions (ai_ops.py — 异常预测)
CREATE TABLE IF NOT EXISTS anomaly_predictions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    metric     VARCHAR(255),
    predicted  REAL,
    confidence REAL,
    details    JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anomaly_pred_device ON anomaly_predictions(device_id);

-- B26. brain_intents (ai_ops.py — Brain 意图)
CREATE TABLE IF NOT EXISTS brain_intents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    status      VARCHAR(50) DEFAULT 'pending',
    reason      TEXT,
    action      JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brain_intents_device ON brain_intents(device_id);
CREATE INDEX IF NOT EXISTS idx_brain_intents_status ON brain_intents(status);

-- B27. skill_executions (ai_ops.py — Skill 执行记录)
CREATE TABLE IF NOT EXISTS skill_executions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_name  VARCHAR(255),
    intent      VARCHAR(255),
    result      VARCHAR(100),
    duration_ms REAL,
    details     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_skill_exec_name ON skill_executions(skill_name);

-- B28. inspection_tasks (ai_ops.py — 巡检任务)
CREATE TABLE IF NOT EXISTS inspection_tasks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(255),
    schedule   VARCHAR(100),
    targets    JSONB DEFAULT '[]',
    enabled    BOOLEAN DEFAULT true,
    last_run   TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B29. inspection_executions (ai_ops.py — 巡检执行记录)
CREATE TABLE IF NOT EXISTS inspection_executions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_name      VARCHAR(255),
    status         VARCHAR(50),
    findings_count INTEGER DEFAULT 0,
    details        JSONB DEFAULT '{}',
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inspection_exec_started ON inspection_executions(started_at DESC);


-- B30. system_scripts (system.py — 系统脚本)
CREATE TABLE IF NOT EXISTS system_scripts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    name        VARCHAR(255),
    content     TEXT,
    language    VARCHAR(50) DEFAULT 'cli',
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_scripts_device ON system_scripts(device_id);

-- B31. system_schedulers (system.py — 系统调度器)
CREATE TABLE IF NOT EXISTS system_schedulers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID,
    name        VARCHAR(255),
    cron        VARCHAR(100),
    script_id   UUID REFERENCES system_scripts(id),
    enabled     BOOLEAN DEFAULT true,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_schedulers_device ON system_schedulers(device_id);

-- B32. script_history (unified_agent.py — 脚本执行历史)
CREATE TABLE IF NOT EXISTS script_history (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    session_id UUID,
    script     TEXT,
    output     TEXT,
    success    BOOLEAN,
    timestamp  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_script_history_device ON script_history(device_id);
CREATE INDEX IF NOT EXISTS idx_script_history_session ON script_history(session_id);
CREATE INDEX IF NOT EXISTS idx_script_history_ts ON script_history(timestamp DESC);

-- B33. template_overrides (prompt_templates.py — 模板覆盖映射)
CREATE TABLE IF NOT EXISTS template_overrides (
    device_id            UUID NOT NULL,
    system_template_name VARCHAR(255) NOT NULL,
    custom_template_id   UUID,
    UNIQUE (device_id, system_template_name)
);

-- B34. knowledge_rule_links (rag.py — 知识条目-告警规则关联)
CREATE TABLE IF NOT EXISTS knowledge_rule_links (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id   TEXT,
    rule_id    UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_rule_links_entry ON knowledge_rule_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_rule_links_rule ON knowledge_rule_links(rule_id);

-- B35. skill_parameter_tuning (skill_parameter_tuner.py)
CREATE TABLE IF NOT EXISTS skill_parameter_tuning (
    id         TEXT PRIMARY KEY,
    data       JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- B36. collected_messages (conversation_collector.py)
CREATE TABLE IF NOT EXISTS collected_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL,
    session_id UUID NOT NULL,
    UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_collected_messages_session ON collected_messages(session_id);

-- B37. ai_analysis (ai_analyzer.py — AI 分析结果)
CREATE TABLE IF NOT EXISTS ai_analysis (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id  UUID,
    type       VARCHAR(100),
    result     JSONB,
    timestamp  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_device ON ai_analysis(device_id);

-- B38. alert_feedback (feedback_service.py — 告警反馈)
CREATE TABLE IF NOT EXISTS alert_feedback (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id   UUID,
    type       VARCHAR(50),
    comment    TEXT,
    actor      VARCHAR(255),
    timestamp  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_alert_feedback_alert ON alert_feedback(alert_id);

-- B39. device_profiles (bff.py — 设备 Profile 持久化)
CREATE TABLE IF NOT EXISTS device_profiles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(255),
    vendor     VARCHAR(255),
    model      VARCHAR(255),
    config     JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B40. inspection_history (bff.py — 巡检历史)
CREATE TABLE IF NOT EXISTS inspection_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status      VARCHAR(50),
    details     JSONB DEFAULT '{}',
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- B41. knowledge_entries (bff.py — 知识条目查询)
CREATE TABLE IF NOT EXISTS knowledge_entries (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content    TEXT,
    metadata   JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B42. health_metrics (monitoring.py — 健康指标采集)
CREATE TABLE IF NOT EXISTS health_metrics (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     VARCHAR(100),
    device_id     UUID,
    metric_name   VARCHAR(100) NOT NULL,
    metric_value  REAL,
    collected_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_health_metrics_device ON health_metrics(tenant_id, device_id);
CREATE INDEX IF NOT EXISTS idx_health_metrics_collected ON health_metrics(collected_at DESC);

-- ============================================================
-- Part C: 为 Node.js/Python 表名不一致创建实际表
-- syslog_manager.py 和 snmp_trap_receiver.py 使用 Node.js 表名
-- 并对这些表执行 INSERT/UPDATE/DELETE，所以必须是真实表
-- ai_ops.py 使用 Python 表名（Part B 已创建）
-- 两套表独立存在，分别服务不同的代码路径
-- ============================================================

-- C1. syslog_parse_rules (syslog_manager.py 使用)
CREATE TABLE IF NOT EXISTS syslog_parse_rules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(255),
    pattern        TEXT,
    pattern_type   VARCHAR(50) DEFAULT 'regex',
    extract_fields TEXT,
    priority       INTEGER DEFAULT 0,
    enabled        BOOLEAN DEFAULT true,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- C2. syslog_source_mappings (syslog_manager.py 使用)
CREATE TABLE IF NOT EXISTS syslog_source_mappings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_ip    VARCHAR(45),
    source_cidr  VARCHAR(50),
    device_id    UUID,
    description  TEXT,
    last_seen_at TIMESTAMPTZ,
    message_rate INTEGER DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- C3. snmp_trap_oid_mappings (snmp_trap_receiver.py 使用)
CREATE TABLE IF NOT EXISTS snmp_trap_oid_mappings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oid         VARCHAR(255),
    event_type  VARCHAR(100),
    severity    VARCHAR(20) DEFAULT 'info',
    description TEXT,
    is_builtin  BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snmp_trap_oid ON snmp_trap_oid_mappings(oid);

-- ============================================================
-- Part D: 数据一致性修复
-- ============================================================

-- D1. 同步 chat_messages.collected 和 is_favorited
-- 确保已有的 is_favorited=true 记录也标记 collected=true
UPDATE chat_messages SET collected = true WHERE is_favorited = true AND collected = false;
