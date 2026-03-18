/**
 * PostgreSQL Migration 004: skill_parameter_tuning + mcp_api_keys
 *
 * 将 SkillParameterTuner（原 JSON 文件存储）和 ApiKeyManager（原 JSON 文件存储）
 * 的数据持久化迁移到 PostgreSQL。
 *
 * 表清单：
 *  37. skill_parameter_usage   — 参数使用记录
 *  38. skill_parameter_recommendations — 参数优化建议
 *  39. skill_ab_tests           — A/B 测试配置
 *  40. mcp_api_keys             — MCP API Key 存储
 *
 * Requirements: E4.13, E5.15
 */

import type { PgMigrationDefinition } from './pgMigrationRunner';

const migration: PgMigrationDefinition = {
  version: 4,
  description: 'skill_parameter_tuning + mcp_api_keys（文件存储迁移到 PostgreSQL）',

  up: `
-- ============================================================
-- 37. skill_parameter_usage（参数使用记录）
-- ============================================================
CREATE TABLE skill_parameter_usage (
  id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  parameters JSONB NOT NULL,
  success BOOLEAN NOT NULL,
  response_time INTEGER NOT NULL,
  satisfaction REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_skill_param_usage_skill ON skill_parameter_usage(skill_name);
CREATE INDEX idx_skill_param_usage_created ON skill_parameter_usage(created_at DESC);

-- ============================================================
-- 38. skill_parameter_recommendations（参数优化建议）
-- ============================================================
CREATE TABLE skill_parameter_recommendations (
  id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  param_name VARCHAR(100) NOT NULL,
  current_value TEXT NOT NULL,
  recommended_value TEXT NOT NULL,
  expected_improvement REAL NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_skill_param_rec_skill ON skill_parameter_recommendations(skill_name);
CREATE INDEX idx_skill_param_rec_status ON skill_parameter_recommendations(status);

-- ============================================================
-- 39. skill_ab_tests（A/B 测试配置）
-- ============================================================
CREATE TABLE skill_ab_tests (
  test_id VARCHAR(100) PRIMARY KEY,
  skill_name VARCHAR(255) NOT NULL,
  param_name VARCHAR(100) NOT NULL,
  control_value TEXT NOT NULL,
  experiment_value TEXT NOT NULL,
  experiment_ratio REAL NOT NULL DEFAULT 0.2,
  min_sample_size INTEGER NOT NULL DEFAULT 20,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  control_stats JSONB NOT NULL DEFAULT '{"count":0,"successCount":0,"totalResponseTime":0}',
  experiment_stats JSONB NOT NULL DEFAULT '{"count":0,"successCount":0,"totalResponseTime":0}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX idx_skill_ab_tests_skill ON skill_ab_tests(skill_name);
CREATE INDEX idx_skill_ab_tests_status ON skill_ab_tests(status);

-- ============================================================
-- 40. mcp_api_keys（MCP API Key 存储）
-- ============================================================
CREATE TABLE mcp_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  tenant_id VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer',
  label VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX idx_mcp_api_keys_prefix ON mcp_api_keys(key_prefix);
CREATE INDEX idx_mcp_api_keys_tenant ON mcp_api_keys(tenant_id);
CREATE INDEX idx_mcp_api_keys_status ON mcp_api_keys(status);
  `,

  down: `
DROP TABLE IF EXISTS mcp_api_keys;
DROP TABLE IF EXISTS skill_ab_tests;
DROP TABLE IF EXISTS skill_parameter_recommendations;
DROP TABLE IF EXISTS skill_parameter_usage;
  `,
};

export default migration;
