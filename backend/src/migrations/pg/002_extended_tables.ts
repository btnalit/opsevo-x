/**
 * PostgreSQL Migration 002: 23 张扩展表
 *
 * 按设计文档 Section 12.2 创建新增的 23 张表，支持：
 * - Brain Loop 记忆持久化
 * - 五维度评估报告
 * - Prompt 知识库向量集合（pgvector）
 * - 工具向量索引（pgvector）
 * - 通知渠道与历史
 * - 知识图谱节点与边
 * - 分布式追踪
 * - 状态机执行历史
 * - 降级状态管理
 * - 指纹去重缓存
 * - Syslog 配置
 * - SNMP 配置
 * - API Profile 持久化
 * - 决策引擎
 * - 学习系统
 *
 * 表清单（编号延续 001）：
 *  13. brain_memory          14. evaluation_reports
 *  15. prompt_knowledge      16. tool_vectors
 *  17. notification_channels 18. notifications
 *  19. knowledge_graph_nodes 20. knowledge_graph_edges
 *  21. traces                22. trace_spans
 *  23. state_machine_executions  24. degradation_states
 *  25. fingerprint_cache     26. syslog_parse_rules
 *  27. syslog_source_mappings    28. snmp_trap_oid_mappings
 *  29. snmp_v3_credentials   30. api_profiles
 *  31. decision_rules        32. decision_history
 *  33. feedback_records      34. learned_patterns
 *  35. learning_records
 *
 * Requirements: C3.13
 */

import type { PgMigrationDefinition } from './pgMigrationRunner';

const migration: PgMigrationDefinition = {
  version: 2,
  description: '23 张扩展表 (Brain/Eval/Vector/Notification/KG/Trace/Decision/Learning)',

  up: `
-- ============================================================
-- 启用扩展（pgvector + pg_trgm）
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- 13. brain_memory（大脑记忆持久化）
-- ============================================================
CREATE TABLE brain_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL,
  memory_type VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  importance_score REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_brain_memory_tick ON brain_memory(tick_id);
CREATE INDEX idx_brain_memory_type ON brain_memory(memory_type);
CREATE INDEX idx_brain_memory_created ON brain_memory(created_at DESC);

-- ============================================================
-- 14. evaluation_reports（评估报告）
-- ============================================================
CREATE TABLE evaluation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL,
  symptom_score REAL NOT NULL,
  metric_score REAL NOT NULL,
  side_effect_score REAL NOT NULL,
  execution_quality_score REAL NOT NULL,
  time_efficiency_score REAL NOT NULL,
  overall_score REAL NOT NULL,
  failure_category VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_reports_tick ON evaluation_reports(tick_id);
CREATE INDEX idx_eval_reports_score ON evaluation_reports(overall_score);
CREATE INDEX idx_eval_reports_created ON evaluation_reports(created_at DESC);

-- ============================================================
-- 15. prompt_knowledge（Prompt 知识库向量集合）
-- ============================================================
CREATE TABLE prompt_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  embedding vector(384),
  category VARCHAR(50) NOT NULL,
  device_types JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  feedback_score REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0,
  source_tick_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_prompt_knowledge_category ON prompt_knowledge(category);
CREATE INDEX idx_prompt_knowledge_score ON prompt_knowledge(feedback_score);
CREATE INDEX idx_prompt_knowledge_embedding ON prompt_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_prompt_knowledge_metadata ON prompt_knowledge USING GIN (metadata);

-- ============================================================
-- 16. tool_vectors（工具向量索引）
-- ============================================================
CREATE TABLE tool_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id VARCHAR(255) NOT NULL UNIQUE,
  tool_name VARCHAR(255) NOT NULL,
  tool_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  embedding vector(384),
  capabilities JSONB NOT NULL DEFAULT '[]',
  success_rate REAL DEFAULT 0.5,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_vectors_type ON tool_vectors(tool_type);
CREATE INDEX idx_tool_vectors_embedding ON tool_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ============================================================
-- 17. notification_channels（通知渠道配置）
-- ============================================================
CREATE TABLE notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  config JSONB NOT NULL,
  severity_filter JSONB NOT NULL DEFAULT '["critical","high","medium","low"]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 18. notifications（通知历史）
-- ============================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES notification_channels(id),
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  severity VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifications_channel ON notifications(channel_id);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

-- ============================================================
-- 19. knowledge_graph_nodes（知识图谱节点）
-- ============================================================
CREATE TABLE knowledge_graph_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  label VARCHAR(255) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  ttl_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_kg_nodes_type ON knowledge_graph_nodes(type);
CREATE INDEX idx_kg_nodes_expires ON knowledge_graph_nodes(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_kg_nodes_properties ON knowledge_graph_nodes USING GIN (properties);

-- ============================================================
-- 20. knowledge_graph_edges（知识图谱边）
-- ============================================================
CREATE TABLE knowledge_graph_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES knowledge_graph_nodes(id) ON DELETE RESTRICT NOT NULL,
  target_id UUID REFERENCES knowledge_graph_nodes(id) ON DELETE RESTRICT NOT NULL,
  type VARCHAR(50) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_kg_edges_source ON knowledge_graph_edges(source_id);
CREATE INDEX idx_kg_edges_target ON knowledge_graph_edges(target_id);
CREATE INDEX idx_kg_edges_type ON knowledge_graph_edges(type);

-- ============================================================
-- 21. traces（追踪记录）
-- ============================================================
CREATE TABLE traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms INTEGER,
  tags JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_traces_name ON traces(name);
CREATE INDEX idx_traces_status ON traces(status);
CREATE INDEX idx_traces_start ON traces(start_time DESC);

-- ============================================================
-- 22. trace_spans（追踪 Span）
-- ============================================================
CREATE TABLE trace_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID REFERENCES traces(id) ON DELETE CASCADE NOT NULL,
  parent_span_id UUID REFERENCES trace_spans(id),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  duration_ms INTEGER,
  tags JSONB NOT NULL DEFAULT '{}',
  logs JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_trace_spans_trace ON trace_spans(trace_id);
CREATE INDEX idx_trace_spans_parent ON trace_spans(parent_span_id);

-- ============================================================
-- 23. state_machine_executions（状态机执行历史）
-- ============================================================
CREATE TABLE state_machine_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_type VARCHAR(100) NOT NULL,
  current_state VARCHAR(100) NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  history JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sm_executions_type ON state_machine_executions(machine_type);
CREATE INDEX idx_sm_executions_status ON state_machine_executions(status);

-- ============================================================
-- 24. degradation_states（降级状态）
-- ============================================================
CREATE TABLE degradation_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability VARCHAR(100) NOT NULL UNIQUE,
  is_degraded BOOLEAN NOT NULL DEFAULT false,
  failure_count INTEGER NOT NULL DEFAULT 0,
  degraded_at TIMESTAMPTZ,
  recovery_at TIMESTAMPTZ,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_degradation_capability ON degradation_states(capability);

-- ============================================================
-- 25. fingerprint_cache（指纹去重缓存）
-- ============================================================
CREATE TABLE fingerprint_cache (
  fingerprint VARCHAR(64) PRIMARY KEY,
  event_id UUID NOT NULL,
  source VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_fingerprint_expires ON fingerprint_cache(expires_at);

-- ============================================================
-- 26. syslog_parse_rules（Syslog 解析规则）
-- ============================================================
CREATE TABLE syslog_parse_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  pattern TEXT NOT NULL,
  pattern_type VARCHAR(20) NOT NULL DEFAULT 'regex',
  extract_fields JSONB NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 27. syslog_source_mappings（Syslog 来源映射）
-- ============================================================
CREATE TABLE syslog_source_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ip VARCHAR(45) NOT NULL,
  source_cidr VARCHAR(50),
  device_id UUID REFERENCES devices(id),
  description TEXT,
  last_seen_at TIMESTAMPTZ,
  message_rate REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_syslog_source_ip ON syslog_source_mappings(source_ip);

-- ============================================================
-- 28. snmp_trap_oid_mappings（SNMP Trap OID 映射）
-- ============================================================
CREATE TABLE snmp_trap_oid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oid VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  description TEXT,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 29. snmp_v3_credentials（SNMP v3 认证配置）
-- ============================================================
CREATE TABLE snmp_v3_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  security_level VARCHAR(20) NOT NULL,
  auth_protocol VARCHAR(10),
  auth_key_encrypted TEXT,
  priv_protocol VARCHAR(10),
  priv_key_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 30. api_profiles（API Driver Profile 配置持久化）
-- ============================================================
CREATE TABLE api_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  config JSONB NOT NULL,
  capability_manifest JSONB NOT NULL,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_api_profiles_profile_id ON api_profiles(profile_id);

-- ============================================================
-- 31. decision_rules（决策规则配置）
-- ============================================================
CREATE TABLE decision_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  condition JSONB NOT NULL,
  action VARCHAR(50) NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_decision_rules_enabled ON decision_rules(enabled);

-- ============================================================
-- 32. decision_history（决策历史记录与审计）
-- ============================================================
CREATE TABLE decision_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  factors JSONB NOT NULL,
  scores JSONB NOT NULL,
  action VARCHAR(50) NOT NULL,
  execution_result JSONB,
  feedback_score REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_decision_history_event ON decision_history(event_id);
CREATE INDEX idx_decision_history_action ON decision_history(action);
CREATE INDEX idx_decision_history_created ON decision_history(created_at DESC);

-- ============================================================
-- 33. feedback_records（用户反馈数据）
-- ============================================================
CREATE TABLE feedback_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100),
  source VARCHAR(50) NOT NULL,
  score REAL NOT NULL,
  comment TEXT,
  context JSONB NOT NULL DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_feedback_tick ON feedback_records(tick_id);
CREATE INDEX idx_feedback_processed ON feedback_records(processed) WHERE processed = false;
CREATE INDEX idx_feedback_created ON feedback_records(created_at DESC);

-- ============================================================
-- 34. learned_patterns（模式学习数据）
-- ============================================================
CREATE TABLE learned_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type VARCHAR(50) NOT NULL,
  pattern_data JSONB NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  validation_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0.0,
  is_promoted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_patterns_type ON learned_patterns(pattern_type);
CREATE INDEX idx_patterns_promoted ON learned_patterns(is_promoted);

-- ============================================================
-- 35. learning_records（学习条目持久化）
-- ============================================================
CREATE TABLE learning_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_id VARCHAR(100) NOT NULL,
  learning_type VARCHAR(50) NOT NULL,
  intent_key VARCHAR(255),
  content JSONB NOT NULL,
  source_evaluation_id UUID REFERENCES evaluation_reports(id),
  merged_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_learning_tick ON learning_records(tick_id);
CREATE INDEX idx_learning_type ON learning_records(learning_type);
CREATE INDEX idx_learning_intent ON learning_records(intent_key);

-- ============================================================
-- GIN 索引（JSONB 列加速查询）
-- ============================================================
CREATE INDEX idx_brain_memory_content_gin ON brain_memory USING GIN (content);
CREATE INDEX idx_brain_memory_context_gin ON brain_memory USING GIN (context);
CREATE INDEX idx_eval_reports_details_gin ON evaluation_reports USING GIN (details);
CREATE INDEX idx_notification_channels_config_gin ON notification_channels USING GIN (config);
CREATE INDEX idx_notification_channels_severity_gin ON notification_channels USING GIN (severity_filter);
CREATE INDEX idx_traces_tags_gin ON traces USING GIN (tags);
CREATE INDEX idx_traces_metadata_gin ON traces USING GIN (metadata);
CREATE INDEX idx_trace_spans_tags_gin ON trace_spans USING GIN (tags);
CREATE INDEX idx_trace_spans_logs_gin ON trace_spans USING GIN (logs);
CREATE INDEX idx_sm_executions_context_gin ON state_machine_executions USING GIN (context);
CREATE INDEX idx_sm_executions_history_gin ON state_machine_executions USING GIN (history);
CREATE INDEX idx_syslog_parse_rules_fields_gin ON syslog_parse_rules USING GIN (extract_fields);
CREATE INDEX idx_api_profiles_config_gin ON api_profiles USING GIN (config);
CREATE INDEX idx_api_profiles_manifest_gin ON api_profiles USING GIN (capability_manifest);
CREATE INDEX idx_decision_rules_condition_gin ON decision_rules USING GIN (condition);
CREATE INDEX idx_decision_history_factors_gin ON decision_history USING GIN (factors);
CREATE INDEX idx_decision_history_scores_gin ON decision_history USING GIN (scores);
CREATE INDEX idx_feedback_context_gin ON feedback_records USING GIN (context);
CREATE INDEX idx_patterns_data_gin ON learned_patterns USING GIN (pattern_data);
CREATE INDEX idx_learning_content_gin ON learning_records USING GIN (content);
CREATE INDEX idx_tool_vectors_capabilities_gin ON tool_vectors USING GIN (capabilities);
CREATE INDEX idx_tool_vectors_metadata_gin ON tool_vectors USING GIN (metadata);
CREATE INDEX idx_kg_edges_properties_gin ON knowledge_graph_edges USING GIN (properties);
  `,

  down: `
-- ============================================================
-- 按依赖关系反序删除
-- ============================================================

-- 删除 GIN 索引
DROP INDEX IF EXISTS idx_kg_edges_properties_gin;
DROP INDEX IF EXISTS idx_tool_vectors_metadata_gin;
DROP INDEX IF EXISTS idx_tool_vectors_capabilities_gin;
DROP INDEX IF EXISTS idx_learning_content_gin;
DROP INDEX IF EXISTS idx_patterns_data_gin;
DROP INDEX IF EXISTS idx_feedback_context_gin;
DROP INDEX IF EXISTS idx_decision_history_scores_gin;
DROP INDEX IF EXISTS idx_decision_history_factors_gin;
DROP INDEX IF EXISTS idx_decision_rules_condition_gin;
DROP INDEX IF EXISTS idx_api_profiles_manifest_gin;
DROP INDEX IF EXISTS idx_api_profiles_config_gin;
DROP INDEX IF EXISTS idx_syslog_parse_rules_fields_gin;
DROP INDEX IF EXISTS idx_sm_executions_history_gin;
DROP INDEX IF EXISTS idx_sm_executions_context_gin;
DROP INDEX IF EXISTS idx_trace_spans_logs_gin;
DROP INDEX IF EXISTS idx_trace_spans_tags_gin;
DROP INDEX IF EXISTS idx_traces_metadata_gin;
DROP INDEX IF EXISTS idx_traces_tags_gin;
DROP INDEX IF EXISTS idx_notification_channels_severity_gin;
DROP INDEX IF EXISTS idx_notification_channels_config_gin;
DROP INDEX IF EXISTS idx_eval_reports_details_gin;
DROP INDEX IF EXISTS idx_brain_memory_context_gin;
DROP INDEX IF EXISTS idx_brain_memory_content_gin;

-- 删除表（按 FK 依赖反序）
-- learning_records 依赖 evaluation_reports
DROP TABLE IF EXISTS learning_records;
DROP TABLE IF EXISTS learned_patterns;
DROP TABLE IF EXISTS feedback_records;
DROP TABLE IF EXISTS decision_history;
DROP TABLE IF EXISTS decision_rules;
DROP TABLE IF EXISTS api_profiles;
DROP TABLE IF EXISTS snmp_v3_credentials;
DROP TABLE IF EXISTS snmp_trap_oid_mappings;
-- syslog_source_mappings 依赖 devices（001 表）
DROP TABLE IF EXISTS syslog_source_mappings;
DROP TABLE IF EXISTS syslog_parse_rules;
DROP TABLE IF EXISTS fingerprint_cache;
DROP TABLE IF EXISTS degradation_states;
DROP TABLE IF EXISTS state_machine_executions;
-- trace_spans 依赖 traces（自引用 + traces FK）
DROP TABLE IF EXISTS trace_spans;
DROP TABLE IF EXISTS traces;
-- knowledge_graph_edges 依赖 knowledge_graph_nodes
DROP TABLE IF EXISTS knowledge_graph_edges;
DROP TABLE IF EXISTS knowledge_graph_nodes;
-- notifications 依赖 notification_channels
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS notification_channels;
DROP TABLE IF EXISTS tool_vectors;
DROP TABLE IF EXISTS prompt_knowledge;
-- evaluation_reports 被 learning_records 依赖，已先删
DROP TABLE IF EXISTS evaluation_reports;
DROP TABLE IF EXISTS brain_memory;
  `,
};

export default migration;
