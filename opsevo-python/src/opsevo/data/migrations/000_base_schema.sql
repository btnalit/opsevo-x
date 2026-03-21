-- ============================================================
-- Migration 000: PostgreSQL 基础 Schema（Python 后端独立部署）
-- 目的: 创建所有核心表，使 Python 后端可以在全新 PG 上启动
-- 来源: 合并 Node.js PG 迁移 001-004 的 CREATE TABLE
-- 幂等: 全部使用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- ============================================================

-- ============================================================
-- 扩展
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'viewer',
  tenant_id VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- ============================================================
-- 2. devices
-- ============================================================
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL DEFAULT 443,
  username VARCHAR(255),
  password TEXT,
  driver_type VARCHAR(50) NOT NULL DEFAULT 'api',
  profile_id VARCHAR(100),
  use_tls BOOLEAN NOT NULL DEFAULT false,
  credentials JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'unknown',
  health_score REAL DEFAULT 0,
  tenant_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_driver_type ON devices(driver_type);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

-- ============================================================
-- 3. alert_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  condition JSONB NOT NULL DEFAULT '{}',
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  enabled BOOLEAN NOT NULL DEFAULT true,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  device_filter JSONB,
  metric VARCHAR(255),
  operator VARCHAR(10),
  threshold REAL,
  cooldown_ms INTEGER,
  device_id UUID,
  auto_response TEXT,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_severity ON alert_rules(severity);

-- ============================================================
-- 4. alert_events
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES alert_rules(id),
  device_id UUID,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  title VARCHAR(500),
  description TEXT,
  message TEXT,
  state VARCHAR(20),
  current_value REAL,
  threshold REAL,
  timestamp BIGINT,
  fingerprint VARCHAR(64),
  payload JSONB NOT NULL DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  assigned_to UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status);
CREATE INDEX IF NOT EXISTS idx_alert_events_severity ON alert_events(severity);
CREATE INDEX IF NOT EXISTS idx_alert_events_device ON alert_events(device_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_fingerprint ON alert_events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at DESC);

-- ============================================================
-- 5. audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor VARCHAR(255) NOT NULL DEFAULT 'system',
  action VARCHAR(100) NOT NULL,
  target VARCHAR(255),
  target_type VARCHAR(50),
  device_id UUID,
  details JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

-- ============================================================
-- 6. config_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS config_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  snapshot_type VARCHAR(50),
  config_data JSONB,
  name VARCHAR(255),
  description TEXT,
  snapshot_data TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_device ON config_snapshots(device_id);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_created ON config_snapshots(created_at DESC);

-- ============================================================
-- 7. chat_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500),
  user_id UUID,
  device_id UUID,
  mode VARCHAR(50),
  type VARCHAR(50),
  config JSONB NOT NULL DEFAULT '{}',
  message_count INTEGER NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

-- ============================================================
-- 8. chat_messages
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_favorited BOOLEAN NOT NULL DEFAULT false,
  collected BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

-- ============================================================
-- 9. prompt_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  template TEXT,
  content TEXT,
  variables JSONB NOT NULL DEFAULT '[]',
  device_types JSONB NOT NULL DEFAULT '[]',
  device_id UUID,
  placeholders JSONB,
  is_default BOOLEAN DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category);

-- ============================================================
-- 10. monitoring_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS monitoring_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  metric VARCHAR(100) NOT NULL,
  value REAL NOT NULL,
  unit VARCHAR(20),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_monitoring_device_metric ON monitoring_snapshots(device_id, metric);
CREATE INDEX IF NOT EXISTS idx_monitoring_created ON monitoring_snapshots(created_at DESC);

-- ============================================================
-- 11. vector_documents
-- ============================================================
CREATE TABLE IF NOT EXISTS vector_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vector_docs_collection ON vector_documents(collection);

-- ============================================================
-- 12. ai_configs (Python 代码统一使用此表名)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  provider VARCHAR(50) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL DEFAULT '',
  model VARCHAR(255),
  model_name VARCHAR(255),
  api_key TEXT,
  api_key_encrypted TEXT,
  base_url VARCHAR(500),
  config JSONB NOT NULL DEFAULT '{}',
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_configs_provider ON ai_configs(provider);
CREATE INDEX IF NOT EXISTS idx_ai_configs_device ON ai_configs(device_id);

-- ============================================================
-- 13. brain_memory
-- ============================================================
CREATE TABLE IF NOT EXISTS brain_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL,
  memory_type VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  importance_score REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brain_memory_tick ON brain_memory(tick_id);
CREATE INDEX IF NOT EXISTS idx_brain_memory_type ON brain_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_brain_memory_created ON brain_memory(created_at DESC);

-- ============================================================
-- 14. evaluation_reports
-- ============================================================
CREATE TABLE IF NOT EXISTS evaluation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL,
  plan_id VARCHAR(255),
  symptom_score REAL NOT NULL DEFAULT 0,
  metric_score REAL NOT NULL DEFAULT 0,
  side_effect_score REAL NOT NULL DEFAULT 0,
  execution_quality_score REAL NOT NULL DEFAULT 0,
  time_efficiency_score REAL NOT NULL DEFAULT 0,
  overall_score REAL NOT NULL DEFAULT 0,
  failure_category VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_reports_tick ON evaluation_reports(tick_id);
CREATE INDEX IF NOT EXISTS idx_eval_reports_created ON evaluation_reports(created_at DESC);

-- ============================================================
-- 15. prompt_knowledge
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  embedding vector(384),
  category VARCHAR(50) NOT NULL DEFAULT '',
  device_types JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  feedback_score REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_tick_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prompt_knowledge_category ON prompt_knowledge(category);

-- ============================================================
-- 16. tool_vectors
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id VARCHAR(255) NOT NULL UNIQUE,
  tool_name VARCHAR(255) NOT NULL,
  tool_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  embedding vector(384),
  capabilities JSONB NOT NULL DEFAULT '[]',
  success_rate REAL DEFAULT 0.5,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_vectors_type ON tool_vectors(tool_type);

-- ============================================================
-- 17. notification_channels
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  severity_filter JSONB NOT NULL DEFAULT '["critical","high","medium","low"]',
  device_id UUID,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 18. notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID,
  title VARCHAR(500) NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  severity VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  device_id UUID,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- ============================================================
-- 19. knowledge_graph_nodes
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  label VARCHAR(255) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  ttl_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON knowledge_graph_nodes(type);

-- ============================================================
-- 20. knowledge_graph_edges
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID,
  target_id UUID,
  type VARCHAR(50) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON knowledge_graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON knowledge_graph_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON knowledge_graph_edges(type);

-- ============================================================
-- 21-22. traces + trace_spans
-- ============================================================
CREATE TABLE IF NOT EXISTS traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms INTEGER,
  tags JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_traces_name ON traces(name);

CREATE TABLE IF NOT EXISTS trace_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID,
  parent_span_id UUID,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms INTEGER,
  tags JSONB NOT NULL DEFAULT '{}',
  logs JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id);

-- ============================================================
-- 23. state_machine_executions
-- ============================================================
CREATE TABLE IF NOT EXISTS state_machine_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_type VARCHAR(100) NOT NULL,
  current_state VARCHAR(100) NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  history JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 24. degradation_states
-- ============================================================
CREATE TABLE IF NOT EXISTS degradation_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability VARCHAR(100) NOT NULL UNIQUE,
  is_degraded BOOLEAN NOT NULL DEFAULT false,
  failure_count INTEGER NOT NULL DEFAULT 0,
  degraded_at TIMESTAMPTZ,
  recovery_at TIMESTAMPTZ,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 25. fingerprint_cache
-- ============================================================
CREATE TABLE IF NOT EXISTS fingerprint_cache (
  fingerprint VARCHAR(64) PRIMARY KEY,
  event_id UUID NOT NULL,
  source VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 26-29. syslog + snmp tables
-- ============================================================
CREATE TABLE IF NOT EXISTS syslog_parse_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  pattern TEXT,
  pattern_type VARCHAR(50) DEFAULT 'regex',
  extract_fields TEXT,
  priority INTEGER DEFAULT 0,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syslog_source_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ip VARCHAR(45),
  source_cidr VARCHAR(50),
  device_id UUID,
  description TEXT,
  last_seen_at TIMESTAMPTZ,
  message_rate REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snmp_trap_oid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oid VARCHAR(255),
  event_type VARCHAR(100),
  severity VARCHAR(20) DEFAULT 'info',
  description TEXT,
  is_builtin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snmp_v3_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  username VARCHAR(255),
  security_level VARCHAR(20),
  auth_protocol VARCHAR(10),
  auth_key_encrypted TEXT,
  priv_protocol VARCHAR(10),
  priv_key_encrypted TEXT,
  auth_password TEXT,
  priv_password TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 30. api_profiles
-- ============================================================
CREATE TABLE IF NOT EXISTS api_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id VARCHAR(100) NOT NULL DEFAULT '',
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL DEFAULT '',
  target_system VARCHAR(255) NOT NULL DEFAULT '',
  version VARCHAR(50) NOT NULL DEFAULT '1.0',
  config JSONB NOT NULL DEFAULT '{}',
  endpoints JSONB NOT NULL DEFAULT '{}',
  auth JSONB NOT NULL DEFAULT '{}',
  capability_manifest JSONB NOT NULL DEFAULT '{}',
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 31. decision_rules
-- ============================================================
CREATE TABLE IF NOT EXISTS decision_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL DEFAULT '',
  description TEXT,
  condition JSONB NOT NULL DEFAULT '{}',
  action VARCHAR(50) NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1.0,
  device_id UUID,
  weights JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 32. decision_history
-- ============================================================
CREATE TABLE IF NOT EXISTS decision_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID,
  device_id UUID,
  factors JSONB NOT NULL DEFAULT '{}',
  scores JSONB NOT NULL DEFAULT '{}',
  action VARCHAR(50) NOT NULL DEFAULT '',
  execution_result JSONB,
  feedback_score REAL,
  timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 33. feedback_records
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100),
  source VARCHAR(50) NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  comment TEXT,
  context JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 34. learned_patterns
-- ============================================================
CREATE TABLE IF NOT EXISTS learned_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type VARCHAR(50) NOT NULL DEFAULT '',
  pattern_data JSONB NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  validation_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0.0,
  is_promoted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 35. learning_records
-- ============================================================
CREATE TABLE IF NOT EXISTS learning_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL DEFAULT '',
  learning_type VARCHAR(50) NOT NULL DEFAULT '',
  type VARCHAR(100),
  description TEXT,
  result VARCHAR(100),
  intent_key VARCHAR(255),
  content JSONB NOT NULL DEFAULT '{}',
  source_evaluation_id UUID,
  merged_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 36. feature_flags
-- ============================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key VARCHAR(100) UNIQUE NOT NULL,
  key VARCHAR(255),
  value VARCHAR(50),
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  dependencies JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Unique constraint for Python ON CONFLICT (key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_flags_key_unique') THEN
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_key_unique UNIQUE (key);
  END IF;
END $$;

-- ============================================================
-- 37-40. skill tuning + mcp api keys
-- ============================================================
CREATE TABLE IF NOT EXISTS skill_parameter_usage (
  id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  success BOOLEAN NOT NULL DEFAULT false,
  response_time INTEGER NOT NULL DEFAULT 0,
  satisfaction REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_parameter_recommendations (
  id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  param_name VARCHAR(100) NOT NULL DEFAULT '',
  current_value TEXT NOT NULL DEFAULT '',
  recommended_value TEXT NOT NULL DEFAULT '',
  expected_improvement REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_ab_tests (
  test_id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  param_name VARCHAR(100) NOT NULL DEFAULT '',
  control_value TEXT NOT NULL DEFAULT '',
  experiment_value TEXT NOT NULL DEFAULT '',
  experiment_ratio REAL NOT NULL DEFAULT 0.2,
  min_sample_size INTEGER NOT NULL DEFAULT 20,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  control_stats JSONB NOT NULL DEFAULT '{"count":0,"successCount":0,"totalResponseTime":0}',
  experiment_stats JSONB NOT NULL DEFAULT '{"count":0,"successCount":0,"totalResponseTime":0}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL,
  key_prefix VARCHAR(20) NOT NULL DEFAULT '',
  tenant_id VARCHAR(255) NOT NULL DEFAULT '',
  role VARCHAR(20) NOT NULL DEFAULT 'viewer',
  label VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL DEFAULT 0,
  revoked_at BIGINT
);

-- ============================================================
-- Python-specific tables (from 001_python_schema_alignment Part B)
-- These tables are only used by the Python backend
-- ============================================================

CREATE TABLE IF NOT EXISTS device_settings (
  device_id UUID NOT NULL,
  key VARCHAR(100) NOT NULL,
  config JSONB,
  UNIQUE (device_id, key)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  type VARCHAR(100),
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fault_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  name VARCHAR(255),
  pattern JSONB,
  severity VARCHAR(20) DEFAULT 'warning',
  auto_heal BOOLEAN DEFAULT false,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  status VARCHAR(50),
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fault_pattern_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id UUID,
  event_id UUID,
  matched_at TIMESTAMPTZ,
  similarity REAL
);

CREATE TABLE IF NOT EXISTS remediation_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID,
  device_id UUID,
  pattern_name VARCHAR(255),
  action VARCHAR(255),
  script TEXT,
  success BOOLEAN,
  output TEXT,
  result JSONB,
  timestamp BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  name VARCHAR(255),
  start_time BIGINT,
  end_time BIGINT,
  filters JSONB,
  enabled BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS known_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  title VARCHAR(255),
  name VARCHAR(255),
  description TEXT,
  pattern JSONB,
  auto_resolve BOOLEAN DEFAULT false,
  severity VARCHAR(20),
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  alert_id UUID,
  analysis_id UUID,
  rating INTEGER,
  comment TEXT,
  action_taken VARCHAR(255),
  rule_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID,
  device_id UUID,
  analysis JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID,
  event_type VARCHAR(100),
  details JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduler_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  task_id UUID,
  status VARCHAR(50),
  output TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  cpu_usage REAL,
  memory_usage REAL,
  disk_usage REAL,
  uptime BIGINT,
  metadata JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS traffic_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  interface VARCHAR(255),
  rx_rate REAL,
  tx_rate REAL,
  rx_bytes BIGINT,
  tx_bytes BIGINT,
  metadata JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  status VARCHAR(50),
  score REAL,
  details JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syslog_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  severity VARCHAR(20),
  facility VARCHAR(50),
  message TEXT,
  source_ip VARCHAR(45),
  metadata JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syslog_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  host VARCHAR(255),
  port INTEGER DEFAULT 514,
  protocol VARCHAR(10) DEFAULT 'udp',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syslog_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  pattern TEXT,
  action JSONB,
  priority INTEGER DEFAULT 0,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syslog_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  condition JSONB,
  action VARCHAR(50) DEFAULT 'drop',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snmp_oid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oid VARCHAR(255),
  name VARCHAR(255),
  severity VARCHAR(20) DEFAULT 'info',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  status VARCHAR(50) DEFAULT 'pending',
  config JSONB DEFAULT '{}',
  result JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  category VARCHAR(100),
  content JSONB DEFAULT '{}',
  source VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS critic_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  tick_id VARCHAR(100),
  result VARCHAR(50),
  score REAL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reflector_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  tick_id VARCHAR(100),
  suggestion TEXT,
  applied BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  tool_name VARCHAR(255),
  duration_ms REAL,
  success BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS anomaly_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  metric VARCHAR(255),
  predicted REAL,
  confidence REAL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS brain_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  status VARCHAR(50) DEFAULT 'pending',
  reason TEXT,
  action JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS skill_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name VARCHAR(255),
  intent VARCHAR(255),
  result VARCHAR(100),
  duration_ms REAL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  schedule VARCHAR(100),
  targets JSONB DEFAULT '[]',
  enabled BOOLEAN DEFAULT true,
  last_run TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_name VARCHAR(255),
  status VARCHAR(50),
  findings_count INTEGER DEFAULT 0,
  details JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS system_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  name VARCHAR(255),
  content TEXT,
  language VARCHAR(50) DEFAULT 'cli',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_schedulers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  name VARCHAR(255),
  cron VARCHAR(100),
  script_id UUID,
  enabled BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS script_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  session_id UUID,
  script TEXT,
  output TEXT,
  success BOOLEAN,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_overrides (
  device_id UUID NOT NULL,
  system_template_name VARCHAR(255) NOT NULL,
  custom_template_id UUID,
  UNIQUE (device_id, system_template_name)
);

CREATE TABLE IF NOT EXISTS knowledge_rule_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id TEXT,
  rule_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_parameter_tuning (
  id TEXT PRIMARY KEY,
  data JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collected_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE,
  session_id UUID NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID,
  type VARCHAR(100),
  result JSONB,
  timestamp BIGINT
);

CREATE TABLE IF NOT EXISTS alert_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID,
  type VARCHAR(50),
  comment TEXT,
  actor VARCHAR(255),
  timestamp BIGINT
);

CREATE TABLE IF NOT EXISTS device_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  vendor VARCHAR(255),
  model VARCHAR(255),
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspection_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(50),
  details JSONB DEFAULT '{}',
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100),
  device_id UUID,
  metric_name VARCHAR(100) NOT NULL,
  metric_value REAL,
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- scheduled_tasks (Python 002 migration merged here)
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- brain_memory kv cache (ai_ops_kv)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_ops_kv (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- knowledge_embeddings for RAG vector store
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding vector(384),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_embedding ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
