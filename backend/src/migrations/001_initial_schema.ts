/**
 * 初始数据库 Schema 迁移
 *
 * 包含所有 12 张业务表 + FTS5 虚拟表 + 索引
 * 注意：schema_migrations 表由 DataStore.runMigrations() 自动管理，不在此处创建
 *
 * Requirements: 2.1, 2.4
 */
import { MigrationDefinition } from '../types/migration';

const migration: MigrationDefinition = {
  version: 1,

  up: `
    -- ============================================================
    -- 用户表
    -- ============================================================
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 设备表
    -- ============================================================
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 8728,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      use_tls INTEGER DEFAULT 0,
      group_name TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'offline',
      last_seen TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 告警规则表
    -- ============================================================
    CREATE TABLE alert_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT REFERENCES devices(id),
      name TEXT NOT NULL,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 告警事件表
    -- ============================================================
    CREATE TABLE alert_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT REFERENCES devices(id),
      rule_id TEXT REFERENCES alert_rules(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      metric_value REAL,
      status TEXT DEFAULT 'active',
      acknowledged_at TEXT,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 审计日志表
    -- ============================================================
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      device_id TEXT,
      action TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 配置快照表
    -- ============================================================
    CREATE TABLE config_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL REFERENCES devices(id),
      snapshot_data TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- AI 对话会话表
    -- ============================================================
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT REFERENCES devices(id),
      messages TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 调度任务表
    -- ============================================================
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT REFERENCES devices(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      cron_expression TEXT,
      config TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 向量文档表（替代 LanceDB）
    -- ============================================================
    CREATE TABLE vector_documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 向量文档全文搜索索引 (FTS5)
    -- ============================================================
    CREATE VIRTUAL TABLE vector_documents_fts USING fts5(
      content,
      content='vector_documents',
      content_rowid='rowid'
    );

    -- ============================================================
    -- Prompt 模板表
    -- ============================================================
    CREATE TABLE prompt_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 通知渠道表
    -- ============================================================
    CREATE TABLE notification_channels (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 健康指标表（时序数据）
    -- ============================================================
    CREATE TABLE health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      collected_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 索引
    -- ============================================================
    CREATE INDEX idx_devices_tenant ON devices(tenant_id);
    CREATE INDEX idx_alert_rules_tenant ON alert_rules(tenant_id);
    CREATE INDEX idx_alert_events_tenant_device ON alert_events(tenant_id, device_id);
    CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id);
    CREATE INDEX idx_chat_sessions_tenant_device ON chat_sessions(tenant_id, device_id);
    CREATE INDEX idx_vector_documents_tenant_collection ON vector_documents(tenant_id, collection);
    CREATE INDEX idx_health_metrics_device_time ON health_metrics(device_id, collected_at);
    CREATE INDEX idx_health_metrics_tenant ON health_metrics(tenant_id);
  `,

  down: `
    -- 按依赖关系的反序删除（先删除有外键引用的表）

    -- 删除索引（DROP TABLE 会自动删除关联索引，但显式删除更清晰）
    DROP INDEX IF EXISTS idx_health_metrics_tenant;
    DROP INDEX IF EXISTS idx_health_metrics_device_time;
    DROP INDEX IF EXISTS idx_vector_documents_tenant_collection;
    DROP INDEX IF EXISTS idx_chat_sessions_tenant_device;
    DROP INDEX IF EXISTS idx_audit_logs_tenant;
    DROP INDEX IF EXISTS idx_alert_events_tenant_device;
    DROP INDEX IF EXISTS idx_alert_rules_tenant;
    DROP INDEX IF EXISTS idx_devices_tenant;

    -- 删除无外键依赖的表
    DROP TABLE IF EXISTS health_metrics;
    DROP TABLE IF EXISTS notification_channels;
    DROP TABLE IF EXISTS prompt_templates;
    DROP TABLE IF EXISTS vector_documents_fts;
    DROP TABLE IF EXISTS vector_documents;
    DROP TABLE IF EXISTS scheduled_tasks;
    DROP TABLE IF EXISTS chat_sessions;
    DROP TABLE IF EXISTS config_snapshots;
    DROP TABLE IF EXISTS audit_logs;

    -- 删除引用 devices 和 users 的表
    DROP TABLE IF EXISTS alert_events;
    DROP TABLE IF EXISTS alert_rules;

    -- 删除引用 users 的表
    DROP TABLE IF EXISTS devices;

    -- 删除基础表
    DROP TABLE IF EXISTS users;
  `,
};

export default migration;
