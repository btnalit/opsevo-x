/**
 * PostgreSQL Migration 001: 12 张核心业务表
 *
 * 从 SQLite 迁移到 PostgreSQL，按设计文档 Section 12.1 的 DDL：
 * - UUID 主键 + gen_random_uuid()
 * - JSONB 替代 TEXT 存储 JSON
 * - GIN 索引加速 JSONB 查询
 * - TIMESTAMPTZ 替代 TEXT 存储时间
 * - 完整的约束和索引
 *
 * 表清单：
 *   1. users           2. devices          3. alert_rules
 *   4. alert_events    5. audit_logs       6. config_snapshots
 *   7. chat_sessions   8. chat_messages    9. prompt_templates
 *  10. monitoring_snapshots  11. vector_documents  12. api_configs
 *
 * Requirements: C1.3, C1.5
 */

import type { PgMigrationDefinition } from './pgMigrationRunner';

const migration: PgMigrationDefinition = {
  version: 1,
  description: '12 张核心业务表 (PostgreSQL)',

  up: `
-- ============================================================
-- 启用扩展
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. users（用户表）
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- ============================================================
-- 2. devices（设备表）
-- ============================================================
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL DEFAULT 443,
  driver_type VARCHAR(50) NOT NULL,
  profile_id VARCHAR(100),
  credentials JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'unknown',
  health_score REAL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_devices_driver_type ON devices(driver_type);
CREATE INDEX idx_devices_status ON devices(status);

-- ============================================================
-- 3. alert_rules（告警规则表）
-- ============================================================
CREATE TABLE alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  condition JSONB NOT NULL,
  severity VARCHAR(20) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  device_filter JSONB,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX idx_alert_rules_severity ON alert_rules(severity);

-- ============================================================
-- 4. alert_events（告警事件表）
-- ============================================================
CREATE TABLE alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES alert_rules(id),
  device_id UUID REFERENCES devices(id),
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  title VARCHAR(500) NOT NULL,
  description TEXT,
  fingerprint VARCHAR(64),
  payload JSONB NOT NULL DEFAULT '{}',
  assigned_to UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alert_events_status ON alert_events(status);
CREATE INDEX idx_alert_events_severity ON alert_events(severity);
CREATE INDEX idx_alert_events_device ON alert_events(device_id);
CREATE INDEX idx_alert_events_fingerprint ON alert_events(fingerprint);
CREATE INDEX idx_alert_events_created ON alert_events(created_at DESC);

-- ============================================================
-- 5. audit_logs（审计日志表）
-- ============================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target VARCHAR(255),
  target_type VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

-- ============================================================
-- 6. config_snapshots（配置快照表）
-- ============================================================
CREATE TABLE config_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) NOT NULL,
  snapshot_type VARCHAR(50) NOT NULL,
  config_data JSONB NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_config_snapshots_device ON config_snapshots(device_id);
CREATE INDEX idx_config_snapshots_created ON config_snapshots(created_at DESC);

-- ============================================================
-- 7. chat_sessions（对话会话表）
-- ============================================================
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500),
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES devices(id),
  config JSONB NOT NULL DEFAULT '{}',
  message_count INTEGER NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

-- ============================================================
-- 8. chat_messages（对话消息表）
-- ============================================================
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_favorited BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_favorited ON chat_messages(is_favorited) WHERE is_favorited = true;
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);

-- ============================================================
-- 9. prompt_templates（Prompt 模板表）
-- ============================================================
CREATE TABLE prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  template TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]',
  device_types JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_prompt_templates_category ON prompt_templates(category);

-- ============================================================
-- 10. monitoring_snapshots（监控快照表）
-- ============================================================
CREATE TABLE monitoring_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) NOT NULL,
  metric VARCHAR(100) NOT NULL,
  value REAL NOT NULL,
  unit VARCHAR(20),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_monitoring_device_metric ON monitoring_snapshots(device_id, metric);
CREATE INDEX idx_monitoring_created ON monitoring_snapshots(created_at DESC);

-- ============================================================
-- 11. vector_documents（向量文档表 — Python Core 管理）
-- 注意：pgvector 扩展和向量索引在 Task 1.5 中创建
-- ============================================================
CREATE TABLE vector_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_vector_docs_collection ON vector_documents(collection);

-- ============================================================
-- 12. api_configs（AI 提供商配置表）
-- ============================================================
CREATE TABLE api_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_api_configs_provider ON api_configs(provider);

-- ============================================================
-- GIN 索引（JSONB 列加速查询）
-- ============================================================
CREATE INDEX idx_devices_credentials_gin ON devices USING GIN (credentials);
CREATE INDEX idx_devices_metadata_gin ON devices USING GIN (metadata);
CREATE INDEX idx_alert_rules_condition_gin ON alert_rules USING GIN (condition);
CREATE INDEX idx_alert_events_payload_gin ON alert_events USING GIN (payload);
CREATE INDEX idx_audit_logs_details_gin ON audit_logs USING GIN (details);
CREATE INDEX idx_config_snapshots_config_data_gin ON config_snapshots USING GIN (config_data);
CREATE INDEX idx_chat_sessions_config_gin ON chat_sessions USING GIN (config);
CREATE INDEX idx_chat_messages_metadata_gin ON chat_messages USING GIN (metadata);
CREATE INDEX idx_prompt_templates_variables_gin ON prompt_templates USING GIN (variables);
CREATE INDEX idx_monitoring_snapshots_metadata_gin ON monitoring_snapshots USING GIN (metadata);
CREATE INDEX idx_vector_docs_metadata_gin ON vector_documents USING GIN (metadata);
CREATE INDEX idx_api_configs_config_gin ON api_configs USING GIN (config);
  `,

  down: `
-- 按依赖关系反序删除

-- 删除 GIN 索引
DROP INDEX IF EXISTS idx_api_configs_config_gin;
DROP INDEX IF EXISTS idx_vector_docs_metadata_gin;
DROP INDEX IF EXISTS idx_monitoring_snapshots_metadata_gin;
DROP INDEX IF EXISTS idx_prompt_templates_variables_gin;
DROP INDEX IF EXISTS idx_chat_messages_metadata_gin;
DROP INDEX IF EXISTS idx_chat_sessions_config_gin;
DROP INDEX IF EXISTS idx_config_snapshots_config_data_gin;
DROP INDEX IF EXISTS idx_audit_logs_details_gin;
DROP INDEX IF EXISTS idx_alert_events_payload_gin;
DROP INDEX IF EXISTS idx_alert_rules_condition_gin;
DROP INDEX IF EXISTS idx_devices_metadata_gin;
DROP INDEX IF EXISTS idx_devices_credentials_gin;

-- 删除表（按 FK 依赖反序）
DROP TABLE IF EXISTS api_configs;
DROP TABLE IF EXISTS vector_documents;
DROP TABLE IF EXISTS monitoring_snapshots;
DROP TABLE IF EXISTS prompt_templates;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS config_snapshots;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS users;
  `,
};

export default migration;
